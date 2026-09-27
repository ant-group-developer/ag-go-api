import { StatisticsActivityService } from './statistics-activity.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('StatisticsActivityService', () => {
  const context = { userId: 'user-1', userType: 'USER' as const };

  function createService(scope: { folderIds: string[] | null; isAdmin: boolean; empty: boolean }) {
    const dataSource = {
      query: jest.fn(),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({ ...scope, userId: context.userId }),
    };
    const actorEnrichment = {
      enrich: jest.fn(),
    };
    const service = new StatisticsActivityService(
      dataSource as never,
      scopeService as never,
      actorEnrichment as never,
    );
    return { service, dataSource, scopeService, actorEnrichment };
  }

  it('converts createdAt from Date to ISO string and enriches actor', async () => {
    const { service, dataSource, actorEnrichment } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        id: 'log-1',
        action: 'project_created',
        actorUserId: 'user-1',
        projectId: 'p-1',
        projectName: 'Project 1',
        afterData: { name: 'Project 1' },
        createdAt: new Date('2026-09-05T08:00:00+07:00'),
      },
    ]);
    actorEnrichment.enrich.mockResolvedValueOnce([
      {
        id: 'log-1',
        action: 'project_created',
        actorUserId: 'user-1',
        actorUser: { id: 'user-1', name: 'User One' },
        projectId: 'p-1',
        projectName: 'Project 1',
        afterData: { name: 'Project 1' },
        createdAt: '2026-09-05T01:00:00.000Z',
      },
    ]);

    const result = await service.activity(context, { limit: 15 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].createdAt).toBe('2026-09-05T01:00:00.000Z');
    expect(result.items[0].actorUser).toEqual({ id: 'user-1', name: 'User One' });
  });

  it('passes actorUserId mapping to enrichment service', async () => {
    const { service, dataSource, actorEnrichment } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        id: 'log-1',
        action: 'media_uploaded',
        actorUserId: 'user-2',
        projectId: 'p-1',
        projectName: 'Project 1',
        afterData: { count: 5 },
        createdAt: new Date('2026-09-05T12:00:00Z'),
      },
    ]);
    actorEnrichment.enrich.mockResolvedValueOnce([]);

    await service.activity(context, {});

    expect(actorEnrichment.enrich).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: 'user-2',
          createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ]),
      [{ id: 'actorUserId', target: 'actorUser' }],
    );
  });

  it('returns empty items for empty scope without querying', async () => {
    const { service, dataSource, actorEnrichment } = createService({
      folderIds: [],
      isAdmin: false,
      empty: true,
    });

    const result = await service.activity(context, {});

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(actorEnrichment.enrich).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
  });

  it('uses DEFAULT_LIMIT when limit not provided', async () => {
    const { service, dataSource, actorEnrichment } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([]);
    actorEnrichment.enrich.mockResolvedValueOnce([]);

    await service.activity(context, {});

    expect(dataSource.query.mock.calls[0][1][3]).toBe(15);
  });

  it('passes custom limit to dataSource.query', async () => {
    const { service, dataSource, actorEnrichment } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([]);
    actorEnrichment.enrich.mockResolvedValueOnce([]);

    await service.activity(context, { limit: 25 });

    expect(dataSource.query.mock.calls[0][1][3]).toBe(25);
  });

  it('handles multiple audit log entries', async () => {
    const { service, dataSource, actorEnrichment } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        id: 'log-1',
        action: 'project_created',
        actorUserId: 'user-1',
        projectId: 'p-1',
        projectName: 'Project 1',
        afterData: { name: 'Project 1' },
        createdAt: new Date('2026-09-05T08:00:00Z'),
      },
      {
        id: 'log-2',
        action: 'media_uploaded',
        actorUserId: 'user-2',
        projectId: 'p-1',
        projectName: 'Project 1',
        afterData: { count: 3 },
        createdAt: new Date('2026-09-04T10:00:00Z'),
      },
    ]);
    actorEnrichment.enrich.mockResolvedValueOnce([
      {
        id: 'log-1',
        action: 'project_created',
        actorUserId: 'user-1',
        actorUser: { id: 'user-1', name: 'User One' },
        projectId: 'p-1',
        projectName: 'Project 1',
        afterData: { name: 'Project 1' },
        createdAt: '2026-09-05T08:00:00.000Z',
      },
      {
        id: 'log-2',
        action: 'media_uploaded',
        actorUserId: 'user-2',
        actorUser: { id: 'user-2', name: 'User Two' },
        projectId: 'p-1',
        projectName: 'Project 1',
        afterData: { count: 3 },
        createdAt: '2026-09-04T10:00:00.000Z',
      },
    ]);

    const result = await service.activity(context, {});

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe('log-1');
    expect(result.items[1].id).toBe('log-2');
  });
});
