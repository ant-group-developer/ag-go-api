import { StatisticsOperationsService } from './statistics-operations.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('StatisticsOperationsService', () => {
  const context = { userId: 'user-1', userType: 'USER' as const };
  const query = { from: '2026-09-01', to: '2026-09-08' };

  function createService(scope: { folderIds: string[] | null; isAdmin: boolean; empty: boolean }) {
    const dataSource = {
      query: jest.fn(),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({ ...scope, userId: context.userId }),
    };
    const service = new StatisticsOperationsService(dataSource as never, scopeService as never);
    return { service, dataSource, scopeService };
  }

  it('merges render rows and converts averageRenderSeconds to number', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        queued: 2,
        processing: 1,
        completed: 10,
        failed: 1,
        cancelled: 0,
        averageRenderSeconds: '45.5',
      },
    ]);
    dataSource.query.mockResolvedValueOnce([
      {
        active: 3,
        paused: 0,
        completed: 5,
        partial: 1,
        failed: 0,
      },
    ]);
    dataSource.query.mockResolvedValueOnce([]);

    const result = await service.operations(context, query);

    expect(result.render.queued).toBe(2);
    expect(result.render.processing).toBe(1);
    expect(result.render.completed).toBe(10);
    expect(result.render.failed).toBe(1);
    expect(result.render.cancelled).toBe(0);
    expect(result.render.averageRenderSeconds).toBe(45.5);
    expect(typeof result.render.averageRenderSeconds).toBe('number');
  });

  it('converts import problem updatedAt to ISO string', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      { queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, averageRenderSeconds: 0 },
    ]);
    dataSource.query.mockResolvedValueOnce([
      { active: 0, paused: 0, completed: 0, partial: 0, failed: 1 },
    ]);
    dataSource.query.mockResolvedValueOnce([
      {
        id: 'batch-1',
        projectId: 'p-1',
        projectName: 'Project 1',
        status: 'failed',
        totalItems: 50,
        failedItems: 25,
        updatedAt: '2026-09-05T12:30:00+07:00',
      },
    ]);

    const result = await service.operations(context, query);

    expect(result.imports.recentProblems[0].updatedAt).toBe('2026-09-05T05:30:00.000Z');
  });

  it('returns empty operations for empty scope without querying', async () => {
    const { service, dataSource } = createService({
      folderIds: [],
      isAdmin: false,
      empty: true,
    });

    const result = await service.operations(context, query);

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(result.render.queued).toBe(0);
    expect(result.render.processing).toBe(0);
    expect(result.render.completed).toBe(0);
    expect(result.render.failed).toBe(0);
    expect(result.render.cancelled).toBe(0);
    expect(result.render.averageRenderSeconds).toBe(0);
    expect(result.imports.active).toBe(0);
    expect(result.imports.paused).toBe(0);
    expect(result.imports.completed).toBe(0);
    expect(result.imports.partial).toBe(0);
    expect(result.imports.failed).toBe(0);
    expect(result.imports.recentProblems).toEqual([]);
  });

  it('sets averageRenderSeconds to 0 when null', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        averageRenderSeconds: null,
      },
    ]);
    dataSource.query.mockResolvedValueOnce([
      { active: 0, paused: 0, completed: 0, partial: 0, failed: 0 },
    ]);
    dataSource.query.mockResolvedValueOnce([]);

    const result = await service.operations(context, query);

    expect(result.render.averageRenderSeconds).toBe(0);
  });

  it('includes period info in result', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValue([]);
    dataSource.query.mockResolvedValueOnce([
      { active: 0, paused: 0, completed: 0, partial: 0, failed: 0 },
    ]);

    const result = await service.operations(context, query);

    expect(result.period).toBeDefined();
    expect(result.period.from).toBeDefined();
    expect(result.period.to).toBeDefined();
    expect(result.period.effectiveTo).toBeDefined();
    expect(result.period.granularity).toBeDefined();
  });

  it('limits recent problems to max 5 items', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      { queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, averageRenderSeconds: 0 },
    ]);
    dataSource.query.mockResolvedValueOnce([
      { active: 0, paused: 0, completed: 0, partial: 0, failed: 0 },
    ]);
    const problems = Array.from({ length: 5 }, (_, i) => ({
      id: `batch-${i}`,
      projectId: `p-${i}`,
      projectName: `Project ${i}`,
      status: 'failed',
      totalItems: 10,
      failedItems: 5,
      updatedAt: '2026-09-05T12:00:00Z',
    }));
    dataSource.query.mockResolvedValueOnce(problems);

    const result = await service.operations(context, query);

    expect(result.imports.recentProblems).toHaveLength(5);
  });
});
