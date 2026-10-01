import {
  breakdownTotals,
  sortRows,
  StatisticsBreakdownService,
} from './statistics-breakdown.service';
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
      query: jest.fn<Promise<unknown[]>, [string, unknown[]]>(() =>
        Promise.resolve([
          row(null, { projects: 1, media: 2, images: 2 }),
          row('cat-2', { label: 'Beach', projects: '3' as never, media: 10, videos: 10 }),
          row('cat-1', { label: 'City', projects: 5, media: 4, images: 4 }),
        ]),
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

  it('groups by the requested dimension and sums the rows into totals', async () => {
    const { service, dataSource } = createService();

    const result = await service.breakdown(context, { ...period, dimension: 'category' });

    expect(result.range).toBe('all');
    expect(result.totals).toEqual({ projects: 9, media: 16, images: 6, videos: 10 });
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(result.rows.map((item) => [item.key, item.projects])).toEqual([
      ['cat-1', 5],
      ['cat-2', 3],
      [null, 1],
    ]);
    const [sql, values] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('categories');
    // The whole scope reads the project counters and binds only the scope.
    expect(sql).toContain('media_count');
    expect(values).toHaveLength(3);
  });

  it('only counts the period when asked to', async () => {
    const { service, dataSource } = createService();

    await service.breakdown(context, { ...period, dimension: 'resolution', range: 'period' });

    const [sql, values] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('source_short_edge');
    expect(sql).toContain('pm.created_at >= $4');
    expect(values).toHaveLength(5);
  });

  it('returns nothing without querying when the user has no folder', async () => {
    const { service, dataSource } = createService(true);

    const result = await service.breakdown(context, { ...period, dimension: 'tag' });

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.totals).toBeNull();
  });
});

describe('breakdownTotals', () => {
  const rows = [
    row('a', { projects: 2, media: 5, images: 1, videos: 4 }),
    row(null, { projects: 1, media: 1, images: 1 }),
  ];

  it('sums every column for single-valued groupings', () => {
    expect(breakdownTotals('country', rows)).toEqual({
      projects: 3,
      media: 6,
      images: 2,
      videos: 4,
    });
  });

  it('leaves out the project total when a project spans several rows', () => {
    expect(breakdownTotals('extension', rows)).toEqual({
      projects: null,
      media: 6,
      images: 2,
      videos: 4,
    });
  });

  it('has no totals for tags', () => {
    expect(breakdownTotals('tag', rows)).toBeNull();
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
