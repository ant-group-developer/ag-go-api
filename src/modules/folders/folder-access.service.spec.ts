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
});
