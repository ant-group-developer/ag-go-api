import { FolderAccessOverviewService } from './folder-access-overview.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

describe('FolderAccessOverviewService', () => {
  const folders = [
    { id: 'f-a', name: 'A', pathText: 'A' },
    { id: 'f-b', name: 'B', pathText: 'A / B' },
  ];
  const grant = (folderId: string, principalId: string, accessLevel: string, day: number) => ({
    folderId,
    principalId,
    accessLevel,
    updatedAt: new Date(Date.UTC(2026, 8, day)),
  });
  const grants = [
    grant('f-a', 'u-1', 'viewer', 1),
    grant('f-b', 'u-1', 'editor', 3),
    grant('f-b', 'u-2', 'manager', 2),
  ];
  const users: Record<string, { id: string; name: string; email: string }> = {
    'u-1': { id: 'u-1', name: 'Bình', email: 'binh@test.dev' },
    'u-2': { id: 'u-2', name: 'An', email: 'an@test.dev' },
  };

  function createService(managedFolderIds: string[] = ['f-a', 'f-b']) {
    const folderRepository = {
      find: jest.fn().mockResolvedValue(folders),
    };
    const grantRepository = { find: jest.fn().mockResolvedValue(grants) };
    const accessService = {
      accessLevels: jest
        .fn()
        .mockResolvedValue(new Map(managedFolderIds.map((id) => [id, 'manager']))),
    };
    const actorEnrichment = {
      enrich: jest.fn((rows: Array<{ userId: string }>) =>
        Promise.resolve(rows.map((row) => ({ ...row, user: users[row.userId] ?? null }))),
      ),
    };
    const service = new FolderAccessOverviewService(
      grantRepository as never,
      folderRepository as never,
      accessService as never,
      actorEnrichment as never,
    );
    return { service, folderRepository };
  }

  it('groups direct grants by user with folder count, highest level and last update', async () => {
    const { service } = createService();

    const result = await service.users({}, 'requester', 'USER');

    expect(result.total).toBe(2);
    expect(result.data.map((row) => row.userId)).toEqual(['u-2', 'u-1']);
    expect(result.data[1]).toMatchObject({
      folderCount: 2,
      highestLevel: 'editor',
      lastUpdatedAt: new Date(Date.UTC(2026, 8, 3)),
    });
    expect(result.data[1]?.folders.map((folder) => folder.pathText)).toEqual(['A', 'A / B']);
  });

  it('returns nothing when the requester manages no folder', async () => {
    const { service, folderRepository } = createService([]);

    await expect(service.users({}, 'requester', 'USER')).resolves.toEqual({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
    });
    expect(folderRepository.find).not.toHaveBeenCalled();
  });

  it('filters by keyword, sorts and paginates', async () => {
    const { service } = createService();

    const byEmail = await service.users({ keyword: 'BINH@' }, 'requester', 'USER');
    expect(byEmail.data.map((row) => row.userId)).toEqual(['u-1']);

    const sorted = await service.users(
      { sortBy: 'folderCount', sortOrder: 'desc', limit: 1, page: 2 },
      'requester',
      'USER',
    );
    expect(sorted).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(sorted.data.map((row) => row.userId)).toEqual(['u-2']);
  });
});
