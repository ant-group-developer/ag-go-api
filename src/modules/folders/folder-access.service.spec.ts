import { FolderAccessService } from './folder-access.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

describe('FolderAccessService', () => {
  function createService(
    closureRows: Array<{ ancestorId: string; descendantId: string; depth: number }>,
    grants: Array<{
      folderId: string;
      principalType: 'user';
      principalId: string;
      accessLevel: 'viewer' | 'editor' | 'manager';
      inheritChildren: boolean;
    }>,
    categoryGrants: Array<{ categoryId: string; principalId: string }> = [],
  ) {
    const grantQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(grants),
    };
    return new FolderAccessService(
      {
        find: jest.fn().mockResolvedValue(grants),
        createQueryBuilder: jest.fn().mockReturnValue(grantQuery),
      } as never,
      {
        find: jest.fn().mockResolvedValue(closureRows),
      } as never,
      {
        find: jest.fn().mockResolvedValue([]),
      } as never,
      {
        exists: jest.fn(({ where }: { where: { categoryId: string; principalId: string } }) =>
          Promise.resolve(
            categoryGrants.some(
              (grant) =>
                grant.categoryId === where.categoryId && grant.principalId === where.principalId,
            ),
          ),
        ),
      } as never,
    );
  }

  it('allows a user grant to be inherited by descendants', async () => {
    const service = createService(
      [{ ancestorId: 'root', descendantId: 'child', depth: 1 }],
      [
        {
          folderId: 'root',
          principalType: 'user',
          principalId: 'alice',
          accessLevel: 'viewer',
          inheritChildren: true,
        },
      ],
    );

    await expect(service.canAccess('child', 'alice', 'viewer')).resolves.toBe(true);
  });

  it('does not inherit a grant when inherit_children is false', async () => {
    const service = createService(
      [{ ancestorId: 'root', descendantId: 'child', depth: 1 }],
      [
        {
          folderId: 'root',
          principalType: 'user',
          principalId: 'alice',
          accessLevel: 'manager',
          inheritChildren: false,
        },
      ],
    );

    await expect(service.canAccess('child', 'alice', 'viewer')).resolves.toBe(false);
  });

  it('computes the highest effective level per folder', async () => {
    const service = createService(
      [
        { ancestorId: 'root', descendantId: 'root', depth: 0 },
        { ancestorId: 'root', descendantId: 'child', depth: 1 },
        { ancestorId: 'root', descendantId: 'grandchild', depth: 2 },
        { ancestorId: 'child', descendantId: 'child', depth: 0 },
        { ancestorId: 'child', descendantId: 'grandchild', depth: 1 },
      ],
      [
        {
          folderId: 'root',
          principalType: 'user',
          principalId: 'alice',
          accessLevel: 'viewer',
          inheritChildren: true,
        },
        {
          folderId: 'child',
          principalType: 'user',
          principalId: 'alice',
          accessLevel: 'manager',
          inheritChildren: false,
        },
      ],
    );

    const levels = await service.accessLevels('alice');

    expect(levels.get('root')).toBe('viewer');
    expect(levels.get('child')).toBe('manager');
    expect(levels.get('grandchild')).toBe('viewer');
  });

  it('returns no folders for a user without grants', async () => {
    const service = createService([{ ancestorId: 'root', descendantId: 'root', depth: 0 }], []);

    await expect(service.accessLevels('bob')).resolves.toEqual(new Map());
  });

  it('reads grants through the given entity manager', async () => {
    const service = createService([], []);
    const grantQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const manager = {
      getRepository: jest.fn((entity: { name: string }) =>
        entity.name === 'FolderClosureEntity'
          ? {
              find: jest
                .fn()
                .mockResolvedValue([{ ancestorId: 'root', descendantId: 'root', depth: 0 }]),
            }
          : { createQueryBuilder: jest.fn().mockReturnValue(grantQuery) },
      ),
    };

    await expect(
      service.canAccess('root', 'alice', 'manager', 'USER', manager as never),
    ).resolves.toBe(false);
    expect(manager.getRepository).toHaveBeenCalledTimes(2);
  });

  describe('canViewProject', () => {
    const project = {
      folderId: 'root',
      categoryId: 'news',
      ownerUserId: 'owner',
      evaluationStatus: 'completed' as const,
    };

    it('lets the owner view their project without any grant', async () => {
      const service = createService([], []);

      await expect(service.canViewProject(project, 'owner', 'USER')).resolves.toBe(true);
    });

    it('lets a category grant view an evaluated project of that category', async () => {
      const service = createService([], [], [{ categoryId: 'news', principalId: 'alice' }]);

      await expect(service.canViewProject(project, 'alice', 'USER')).resolves.toBe(true);
      await expect(
        service.canViewProject({ ...project, categoryId: 'sport' }, 'alice', 'USER'),
      ).resolves.toBe(false);
    });

    it('does not let a category grant view a project still being evaluated', async () => {
      const service = createService([], [], [{ categoryId: 'news', principalId: 'alice' }]);

      await expect(
        service.canViewProject({ ...project, evaluationStatus: 'pending' }, 'alice', 'USER'),
      ).resolves.toBe(false);
    });

    it('still accepts a folder viewer grant', async () => {
      const service = createService(
        [{ ancestorId: 'root', descendantId: 'root', depth: 0 }],
        [
          {
            folderId: 'root',
            principalType: 'user',
            principalId: 'bob',
            accessLevel: 'viewer',
            inheritChildren: true,
          },
        ],
      );

      await expect(
        service.canViewProject({ ...project, evaluationStatus: 'pending' }, 'bob', 'USER'),
      ).resolves.toBe(true);
    });
  });
});
