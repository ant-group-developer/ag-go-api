import { sortRows, StatisticsBreakdownService } from './statistics-breakdown.service';
import type { StatisticsBreakdownRow } from './statistics.types';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

function row(key: string | null, values: Partial<StatisticsBreakdownRow> = {}) {
  return {
    key,
    label: null,
    code: null,
    flagUrl: null,
    projects: 0,
    media: 0,
    images: 0,
    videos: 0,
    ...values,
  };
}

describe('StatisticsBreakdownService', () => {
  const period = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' };
  const context = { userId: 'user-1', userType: 'USER' as const };

  function createService(empty = false) {
    const dataSource = {
      query: jest.fn<Promise<unknown[]>, [string, unknown[]]>((sql) =>
        Promise.resolve(
          sql.includes('GROUP BY key')
            ? [
                row(null, { projects: 1, media: 2, images: 2 }),
                row('cat-2', { label: 'Beach', projects: '3' as never, media: 10, videos: 10 }),
                row('cat-1', { label: 'City', projects: 5, media: 4, images: 4 }),
              ]
            : [{ projects: 9, media: 16, images: 6, videos: 10 }],
        ),
      ),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({
        folderIds: empty ? [] : ['folder-1'],
        isAdmin: false,
        userId: context.userId,
        empty,
      }),
    };
    const service = new StatisticsBreakdownService(dataSource as never, scopeService as never);
    return { service, dataSource };
  }

  it('groups by the requested dimension and returns the distinct totals', async () => {
    const { service, dataSource } = createService();

    const result = await service.breakdown(context, { ...period, dimension: 'category' });

    expect(result.range).toBe('all');
    expect(result.totals).toEqual({ projects: 9, media: 16, images: 6, videos: 10 });
    expect(result.rows.map((item) => [item.key, item.projects])).toEqual([
      ['cat-1', 5],
      ['cat-2', 3],
      [null, 1],
    ]);
    const [sql, values] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('categories');
    expect(values[5]).toBe(true);
  });

  it('only counts the period when asked to', async () => {
    const { service, dataSource } = createService();

    await service.breakdown(context, { ...period, dimension: 'resolution', range: 'period' });

    const [sql, values] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('short_edge');
    expect(values[5]).toBe(false);
  });

  it('returns nothing without querying when the user has no folder', async () => {
    const { service, dataSource } = createService(true);

    const result = await service.breakdown(context, { ...period, dimension: 'tag' });

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.totals.projects).toBe(0);
  });
});

describe('sortRows', () => {
  it('keeps resolution classes in their natural order with unknown sizes last', () => {
    const rows = [row('720p'), row(null), row('4k'), row('1080p')];
    expect(sortRows('resolution', rows).map((item) => item.key)).toEqual([
      '4k',
      '1080p',
      '720p',
      null,
    ]);
  });

  it('ranks extensions by media count', () => {
    const rows = [row('png', { media: 3 }), row('mp4', { media: 8 }), row('jpg', { media: 3 })];
    expect(sortRows('extension', rows).map((item) => item.key)).toEqual(['mp4', 'jpg', 'png']);
  });
});
