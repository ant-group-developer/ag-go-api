import { StatisticsProjectTrendService } from './statistics-project-trend.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('StatisticsProjectTrendService', () => {
  const period = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-04T00:00:00.000Z' };
  const context = { userId: 'user-1', userType: 'USER' as const };

  function createService() {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        { bucketStart: '2026-09-01', projects: 2 },
        { bucketStart: '2026-09-02', projects: 0 },
        { bucketStart: '2026-09-03', projects: '5' },
      ]),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({
        folderIds: ['folder-1'],
        isAdmin: false,
        userId: context.userId,
        empty: false,
      }),
    };
    const service = new StatisticsProjectTrendService(dataSource as never, scopeService as never);
    return { service, dataSource };
  }

  it('returns one point per bucket and their total', async () => {
    const { service, dataSource } = createService();

    const result = await service.projectTrend(context, period);

    expect(result.points).toEqual([
      { bucketStart: '2026-09-01', projects: 2 },
      { bucketStart: '2026-09-02', projects: 0 },
      { bucketStart: '2026-09-03', projects: 5 },
    ]);
    expect(result.total).toBe(7);
    expect(result.period.granularity).toBe('day');
    const [, values] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(values.slice(0, 3)).toEqual([['folder-1'], false, 'user-1']);
    expect(values.slice(5)).toEqual(['Asia/Ho_Chi_Minh', 'day']);
  });
});
