import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FolderEntity } from '../../database/entities/folder.entity';
import { FolderAccessService } from './folder-access.service';
import { FoldersService } from './folders.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

describe('FoldersService.update (move)', () => {
  function folder(values: Partial<FolderEntity>): FolderEntity {
    return { isActive: true, sortOrder: 0, ...values } as FolderEntity;
  }

  function createService(options: {
    intoOwnSubtree?: boolean;
    canAccess?: (folderId: string, minimum: string) => boolean;
  }) {
    const moved = folder({
      id: 'a',
      parentId: 'old',
      name: 'A',
      pathText: 'Old / A',
      pathKey: 'old/a',
      pathIds: ['old', 'a'],
      depth: 1,
    });
    const child = folder({
      id: 'c',
      parentId: 'a',
      name: 'C',
      pathText: 'Old / A / C',
      pathKey: 'old/a/c',
      pathIds: ['old', 'a', 'c'],
      depth: 2,
    });
    const target = folder({
      id: 't',
      parentId: 'root',
      name: 'T',
      pathText: 'Root / T',
      pathKey: 'root/t',
      pathIds: ['root', 't'],
      depth: 1,
    });
    const oldParent = folder({
      id: 'old',
      parentId: null,
      name: 'Old',
      pathText: 'Old',
      pathKey: 'old',
      pathIds: ['old'],
      depth: 0,
    });
    const byId = new Map([moved, child, target, oldParent].map((entry) => [entry.id, entry]));
    const duplicateQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const manager = {
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(
        async (_entity: unknown, { where }: { where: { id: string } }) =>
          byId.get(where.id) ?? null,
      ),
      exists: jest.fn().mockResolvedValue(options.intoOwnSubtree ?? false),
      createQueryBuilder: jest.fn().mockReturnValue(duplicateQuery),
      save: jest.fn(async (value: unknown) => value),
      find: jest.fn(async (entity: unknown) =>
        entity === FolderEntity
          ? [child]
          : [
              { ancestorId: 'a', descendantId: 'a', depth: 0 },
              { ancestorId: 'a', descendantId: 'c', depth: 1 },
            ],
      ),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) =>
      callback(manager),
    );
    const canAccess = jest.fn(async (folderId: string, _userId: string, minimum: string) =>
      options.canAccess ? options.canAccess(folderId, minimum) : true,
    );
    const service = new FoldersService(
      { transaction } as unknown as DataSource,
      {} as never,
      {} as never,
      {} as never,
      { canAccess } as unknown as FolderAccessService,
      {} as never,
    );
    return { service, manager, canAccess, moved, child };
  }

  it('moves the folder and rewrites the paths of its subtree', async () => {
    const { service, manager, canAccess, moved, child } = createService({});

    await service.update('a', { parentId: 't' }, 'alice', 'USER');

    expect(canAccess).toHaveBeenCalledWith('a', 'alice', 'manager', 'USER', manager);
    expect(canAccess).toHaveBeenCalledWith('t', 'alice', 'editor', 'USER', manager);
    expect(moved).toMatchObject({
      parentId: 't',
      pathText: 'Root / T / A',
      pathKey: 'root/t/a',
      pathIds: ['root', 't', 'a'],
      depth: 2,
    });
    expect(child).toMatchObject({
      pathText: 'Root / T / A / C',
      pathKey: 'root/t/a/c',
      pathIds: ['root', 't', 'a', 'c'],
      depth: 3,
    });
    const statements = manager.query.mock.calls.map(([sql]: [string]) => sql);
    expect(statements.some((sql) => sql.includes('DELETE FROM folder_closure'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO folder_closure'))).toBe(true);
  });

  it('moves to the root without linking new ancestors', async () => {
    const { service, manager, moved } = createService({});

    await service.update('a', { parentId: null }, 'alice', 'USER', ['go.folder.create_root']);

    expect(moved).toMatchObject({ parentId: null, pathText: 'A', pathIds: ['a'], depth: 0 });
    const statements = manager.query.mock.calls.map(([sql]: [string]) => sql);
    expect(statements.some((sql) => sql.includes('INSERT INTO folder_closure'))).toBe(false);
  });

  it('rejects moving a folder into its own subtree', async () => {
    const { service, manager } = createService({ intoOwnSubtree: true });

    await expect(service.update('a', { parentId: 't' }, 'alice', 'USER')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('requires manager access on the moved folder', async () => {
    const { service, manager } = createService({
      canAccess: (folderId, minimum) => !(folderId === 'a' && minimum === 'manager'),
    });

    await expect(service.update('a', { parentId: 't' }, 'alice', 'USER')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('rejects a move that would drop the mover’s manager access', async () => {
    let checks = 0;
    const { service } = createService({
      // Manager before the move (inherited from the old parent), not after.
      canAccess: (folderId, minimum) =>
        !(folderId === 'a' && minimum === 'manager' && ++checks > 1),
    });

    await expect(
      service.update('a', { parentId: null }, 'alice', 'USER', ['go.folder.create_root']),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires the create-root permission to move a folder to the root', async () => {
    const { service, manager } = createService({});

    await expect(
      service.update('a', { parentId: null }, 'alice', 'USER', ['go.folder.manage']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('does not treat an unchanged parent as a move', async () => {
    const { service, manager, canAccess } = createService({});

    await service.update('a', { parentId: 'old', name: 'A' }, 'alice', 'USER');

    expect(canAccess).not.toHaveBeenCalledWith('a', 'alice', 'manager', 'USER', manager);
    const statements = manager.query.mock.calls.map(([sql]: [string]) => sql);
    expect(statements.some((sql) => sql.includes('folder_closure'))).toBe(false);
  });
});
