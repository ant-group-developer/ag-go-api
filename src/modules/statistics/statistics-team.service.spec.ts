import { StatisticsTeamService } from './statistics-team.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('StatisticsTeamService', () => {
  const period = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' };
  const context = { userId: 'user-1', userType: 'USER' as const };
  const names: Record<string, string> = { 'u-1': 'An', 'u-2': 'Bình', 'u-3': 'Chi' };

  function createService(empty = false) {
    const dataSource = {
      query: jest
        .fn()
        .mockResolvedValueOnce([
          { userId: 'u-1', approved: 5, rejected: 1, total: 6 },
          { userId: 'u-2', approved: 1, rejected: 0, total: 1 },
        ])
        .mockResolvedValueOnce([{ userId: 'u-3', projectsCreated: 2, mediaAdded: 40 }]),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({
        folderIds: empty ? [] : ['folder-1'],
        isAdmin: false,
        userId: context.userId,
        empty,
      }),
    };
    const actorEnrichment = {
      enrich: jest.fn((rows: Array<{ userId: string }>) =>
        Promise.resolve(rows.map((row) => ({ ...row, user: { name: names[row.userId] } }))),
      ),
    };
    const service = new StatisticsTeamService(
      dataSource as never,
      scopeService as never,
      actorEnrichment as never,
    );
    return { service, dataSource, actorEnrichment };
  }

  it('resolves both lists with one enrichment call and splits them back', async () => {
    const { service, actorEnrichment } = createService();

    const result = await service.team(context, period);

    expect(actorEnrichment.enrich).toHaveBeenCalledTimes(1);
    expect(result.evaluators).toEqual([
      { userId: 'u-1', approved: 5, rejected: 1, total: 6, user: { name: 'An' } },
      { userId: 'u-2', approved: 1, rejected: 0, total: 1, user: { name: 'Bình' } },
    ]);
    expect(result.contributors).toEqual([
      { userId: 'u-3', projectsCreated: 2, mediaAdded: 40, user: { name: 'Chi' } },
    ]);
  });

  it('returns empty lists without querying when the user has no folder', async () => {
    const { service, dataSource, actorEnrichment } = createService(true);

    const result = await service.team(context, period);

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(actorEnrichment.enrich).not.toHaveBeenCalled();
    expect(result).toMatchObject({ evaluators: [], contributors: [] });
  });
});
