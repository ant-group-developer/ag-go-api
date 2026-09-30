import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FolderAccessService } from './folder-access.service';
import { FoldersService } from './folders.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

describe('FoldersService.create', () => {
  const parent = {
    id: 'parent',
    pathKey: 'parent',
    pathIds: ['parent'],
    pathText: 'Parent',
    depth: 0,
  };

  function createService(canAccessResult: boolean) {
    const duplicateQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    const manager = {
      findOne: jest.fn().mockResolvedValue(parent),
      createQueryBuilder: jest.fn().mockReturnValue(duplicateQuery),
      create: jest.fn((_entity: unknown, values: Record<string, unknown>) => ({ ...values })),
      save: jest.fn(async (value: unknown) => value),
      find: jest.fn().mockResolvedValue([]),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) =>
      callback(manager),
    );
    const canAccess = jest.fn().mockResolvedValue(canAccessResult);
    // Empty repositories: any query outside the transaction's manager fails the test.
    const service = new FoldersService(
      { transaction } as unknown as DataSource,
      {} as never,
      {} as never,
      {} as never,
      { canAccess } as unknown as FolderAccessService,
      {} as never,
    );
    return { service, manager, canAccess };
  }

  it('checks parent access on the transaction manager', async () => {
    const { service, manager, canAccess } = createService(true);

    await service.create({ name: 'Child', parentId: 'parent' }, 'alice', 'USER');

    expect(canAccess).toHaveBeenCalledWith('parent', 'alice', 'editor', 'USER', manager);
    expect(manager.insert).toHaveBeenCalled();
  });

  it('rejects without writing when the parent is not editable', async () => {
    const { service, manager, canAccess } = createService(false);

    await expect(
      service.create({ name: 'Child', parentId: 'parent' }, 'alice', 'USER'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(canAccess).toHaveBeenCalledWith('parent', 'alice', 'editor', 'USER', manager);
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it('rejects a root folder without the create-root permission', async () => {
    const { service, manager } = createService(true);

    await expect(
      service.create({ name: 'Root' }, 'alice', 'USER', ['go.folder.manage']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('creates a root folder with the create-root permission', async () => {
    const { service, manager, canAccess } = createService(true);
    manager.findOne.mockResolvedValue(null);

    await service.create({ name: 'Root' }, 'alice', 'USER', ['go.folder.create_root']);

    expect(canAccess).not.toHaveBeenCalled();
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: null, depth: 0 }),
    );
  });

  it('lets admins create a root folder without the permission', async () => {
    const { service, manager } = createService(true);

    await service.create({ name: 'Root' }, 'alice', 'ADMIN');

    expect(manager.save).toHaveBeenCalled();
  });
});
