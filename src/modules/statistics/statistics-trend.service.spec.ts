import { StatisticsTrendService } from './statistics-trend.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('StatisticsTrendService', () => {
  const context = { userId: 'user-1', userType: 'USER' as const };
  const query = { from: '2026-09-01', to: '2026-09-08' };

  function createService(scope: { folderIds: string[] | null; isAdmin: boolean; empty: boolean }) {
    const dataSource = {
      query: jest.fn(),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({ ...scope, userId: context.userId }),
    };
    const service = new StatisticsTrendService(dataSource as never, scopeService as never);
    return { service, dataSource, scopeService };
  }

  it('builds trend series from events with granularity from server', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        currentPending: 5,
        bucketStarts: ['2026-09-01', '2026-09-02', '2026-09-03'],
      },
    ]);
    dataSource.query.mockResolvedValueOnce([
      {
        bucketStart: '2026-09-01',
        isTail: false,
        added: 10,
        approved: 5,
        rejected: 1,
        backlogDelta: 4,
      },
      {
        bucketStart: '2026-09-02',
        isTail: false,
        added: 3,
        approved: 2,
        rejected: 0,
        backlogDelta: 1,
      },
    ]);

    const result = await service.trend(context, query);

    expect(result.points).toBeDefined();
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.period).toBeDefined();
    expect(result.period.granularity).toBeDefined();
  });

  it('passes server granularity to dataSource.query, not request granularity', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValue([{ currentPending: 0, bucketStarts: [] }]);

    await service.trend(context, query);

    const callArgs = dataSource.query.mock.calls[0][1];
    // $7 is the granularity parameter
    expect(callArgs[6]).toMatch(/^(day|week)$/);
  });

  it('returns zero points with buckets for empty scope', async () => {
    const { service, dataSource } = createService({
      folderIds: [],
      isAdmin: false,
      empty: true,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        currentPending: 0,
        bucketStarts: ['2026-09-01', '2026-09-02', '2026-09-03'],
      },
    ]);

    const result = await service.trend(context, query);

    expect(result.points).toBeDefined();
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points.every((p) => p.added === 0 && p.approved === 0 && p.rejected === 0)).toBe(
      true,
    );
  });

  it('returns empty points when no buckets available', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([
      {
        currentPending: 0,
        bucketStarts: [],
      },
    ]);

    const result = await service.trend(context, query);

    expect(result.points).toEqual([]);
  });

  it('includes period info in result', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValue([{ currentPending: 0, bucketStarts: [] }]);

    const result = await service.trend(context, query);

    expect(result.period).toBeDefined();
    expect(result.period.from).toBeDefined();
    expect(result.period.to).toBeDefined();
    expect(result.period.granularity).toMatch(/^(day|week)$/);
    expect(result.period.timeZone).toBeDefined();
  });

  it('handles null bucketStarts from query result', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([{ currentPending: 10, bucketStarts: null }]);

    const result = await service.trend(context, query);

    expect(result.points).toEqual([]);
  });

  it('queries events only when buckets exist and scope not empty', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    dataSource.query.mockResolvedValueOnce([{ currentPending: 5, bucketStarts: ['2026-09-01'] }]);
    dataSource.query.mockResolvedValueOnce([]);

    await service.trend(context, query);

    expect(dataSource.query).toHaveBeenCalledTimes(2);
  });

  it('does not query events for empty scope', async () => {
    const { service, dataSource } = createService({
      folderIds: [],
      isAdmin: false,
      empty: true,
    });
    dataSource.query.mockResolvedValueOnce([{ currentPending: 0, bucketStarts: ['2026-09-01'] }]);

    await service.trend(context, query);

    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('queries the buckets and the events in parallel', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });
    let pending = 0;
    let maxPending = 0;
    dataSource.query.mockImplementation(async () => {
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      await Promise.resolve();
      pending -= 1;
      return [{ currentPending: 5, bucketStarts: [] }];
    });

    await service.trend(context, query);

    expect(dataSource.query).toHaveBeenCalledTimes(2);
    expect(maxPending).toBe(2);
  });

  it('does not query events when the user has no folder', async () => {
    const { service, dataSource } = createService({ folderIds: [], isAdmin: false, empty: true });
    dataSource.query.mockResolvedValueOnce([{ currentPending: 0, bucketStarts: ['2026-09-01'] }]);

    const result = await service.trend(context, query);

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(result.points).toHaveLength(1);
  });
});
