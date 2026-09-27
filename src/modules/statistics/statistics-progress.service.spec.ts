import { StatisticsProgressService } from './statistics-progress.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('StatisticsProgressService', () => {
  const context = { userId: 'user-1', userType: 'USER' as const };

  function createService(scope: { folderIds: string[] | null; isAdmin: boolean; empty: boolean }) {
    const dataSource = {
      query: jest.fn(),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({ ...scope, userId: context.userId }),
    };
    const service = new StatisticsProgressService(dataSource as never, scopeService as never);
    return { service, dataSource, scopeService };
  }

  it('maps folder rows and removes total field with withoutTotal', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        folderId: 'f-1',
        folderName: 'Folder 1',
        folderPath: '/Folder 1',
        projects: 5,
        media: 20,
        approved: 10,
        rejected: 5,
        pending: 5,
        total: 2,
      },
      {
        folderId: 'f-2',
        folderName: 'Folder 2',
        folderPath: '/Folder 2',
        projects: 3,
        media: 10,
        approved: 6,
        rejected: 2,
        pending: 2,
        total: 2,
      },
    ]);
    dataSource.query.mockResolvedValueOnce([]);

    const result = await service.progress(context, { limit: 10 });

    expect(result.folders.total).toBe(2);
    expect(result.folders.items).toHaveLength(2);
    expect(result.folders.items[0]).not.toHaveProperty('total');
    expect(result.folders.items[0]).toEqual({
      folderId: 'f-1',
      folderName: 'Folder 1',
      folderPath: '/Folder 1',
      projects: 5,
      media: 20,
      approved: 10,
      rejected: 5,
      pending: 5,
    });
  });

  it('converts oldestPendingAt from Date to ISO string', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([]);
    dataSource.query.mockResolvedValueOnce([
      {
        projectId: 'p-1',
        projectName: 'Project 1',
        folderPath: '/Folder 1',
        evaluationStatus: 'pending',
        media: 10,
        approved: 3,
        rejected: 1,
        pending: 6,
        oldestPendingAt: '2026-09-01T08:00:00+07:00',
        total: 1,
      },
    ]);

    const result = await service.progress(context, { limit: 10 });

    expect(result.attentionProjects.items[0].oldestPendingAt).toBe('2026-09-01T01:00:00.000Z');
  });

  it('returns zeros for empty scope without querying', async () => {
    const { service, dataSource } = createService({
      folderIds: [],
      isAdmin: false,
      empty: true,
    });

    const result = await service.progress(context, { limit: 10 });

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(result.folders.total).toBe(0);
    expect(result.folders.items).toEqual([]);
    expect(result.attentionProjects.total).toBe(0);
    expect(result.attentionProjects.items).toEqual([]);
  });

  it('handles null oldestPendingAt correctly', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([]);
    dataSource.query.mockResolvedValueOnce([
      {
        projectId: 'p-1',
        projectName: 'Project 1',
        folderPath: '/Folder 1',
        evaluationStatus: 'pending',
        media: 5,
        approved: 3,
        rejected: 1,
        pending: 1,
        oldestPendingAt: null,
        total: 1,
      },
    ]);

    const result = await service.progress(context, { limit: 10 });

    expect(result.attentionProjects.items[0].oldestPendingAt).toBeNull();
  });

  it('passes limit parameter to dataSource.query', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValue([]);

    await service.progress(context, { limit: 25 });

    expect(dataSource.query).toHaveBeenCalledTimes(2);
    expect(dataSource.query.mock.calls[0][1][3]).toBe(25);
    expect(dataSource.query.mock.calls[1][1][3]).toBe(25);
  });

  it('uses DEFAULT_LIMIT when limit not provided', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValue([]);

    await service.progress(context, {});

    expect(dataSource.query.mock.calls[0][1][3]).toBe(10);
  });
});
