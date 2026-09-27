import { buildTrendSeries, type TrendEventRow } from './statistics-trend-series';

function row(bucketStart: string, values: Partial<TrendEventRow>): TrendEventRow {
  return {
    bucketStart,
    isTail: false,
    added: 0,
    approved: 0,
    rejected: 0,
    backlogDelta: 0,
    ...values,
  };
}

describe('buildTrendSeries', () => {
  const buckets = ['2026-09-01', '2026-09-02', '2026-09-03'];

  it('rebuilds the backlog backwards from the current pending count', () => {
    const points = buildTrendSeries(
      buckets,
      [
        row('2026-09-01', { added: 5, backlogDelta: 5 }),
        row('2026-09-03', { approved: 2, rejected: 1, backlogDelta: -3 }),
      ],
      12,
    );

    expect(points.map((point) => point.backlog)).toEqual([15, 15, 12]);
    expect(points[0]).toMatchObject({ added: 5, approved: 0, rejected: 0 });
    expect(points[2]).toMatchObject({ added: 0, approved: 2, rejected: 1 });
  });

  it('removes changes made after the window before rebuilding', () => {
    const points = buildTrendSeries(
      buckets,
      [
        row('2026-09-02', { added: 2, backlogDelta: 2 }),
        row('2026-09-05', { isTail: true, approved: 4, backlogDelta: -4 }),
        row('2026-09-06', { isTail: true, added: 1, backlogDelta: 1 }),
      ],
      10,
    );

    expect(points.map((point) => point.backlog)).toEqual([11, 13, 13]);
  });

  it('fills buckets without events and counts a revert to pending as backlog', () => {
    const points = buildTrendSeries(buckets, [row('2026-09-02', { backlogDelta: 1 })], 1);

    expect(points).toEqual([
      { bucketStart: '2026-09-01', added: 0, approved: 0, rejected: 0, backlog: 0 },
      { bucketStart: '2026-09-02', added: 0, approved: 0, rejected: 0, backlog: 1 },
      { bucketStart: '2026-09-03', added: 0, approved: 0, rejected: 0, backlog: 1 },
    ]);
  });

  it('never reports a negative backlog when history is incomplete', () => {
    const points = buildTrendSeries(buckets, [row('2026-09-03', { backlogDelta: 5 })], 2);

    expect(points.map((point) => point.backlog)).toEqual([0, 0, 2]);
  });

  it('returns no points without buckets', () => {
    expect(buildTrendSeries([], [row('2026-09-01', { added: 1 })], 3)).toEqual([]);
  });
});
