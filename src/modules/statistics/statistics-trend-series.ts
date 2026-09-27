import type { StatisticsTrendPoint } from './statistics.types';

/** Events of one bucket; `isTail` rows happened after the reported window ended. */
export type TrendEventRow = {
  bucketStart: string;
  isTail: boolean;
  added: number;
  approved: number;
  rejected: number;
  /** +1 per media that became pending (added or reverted), -1 per media that left pending. */
  backlogDelta: number;
};

/**
 * Builds one point per bucket and rebuilds the backlog backwards from today's pending count:
 * the backlog at the end of a bucket is the current backlog minus every change that happened
 * after that bucket. Media deleted since then leave no events, so older values are approximate.
 */
export function buildTrendSeries(
  bucketStarts: string[],
  rows: TrendEventRow[],
  currentPending: number,
): StatisticsTrendPoint[] {
  const byBucket = new Map<string, TrendEventRow>();
  let tailDelta = 0;
  for (const row of rows) {
    if (row.isTail) {
      tailDelta += Number(row.backlogDelta);
    } else {
      byBucket.set(row.bucketStart, row);
    }
  }

  const points: StatisticsTrendPoint[] = new Array(bucketStarts.length);
  let backlog = currentPending - tailDelta;
  for (let index = bucketStarts.length - 1; index >= 0; index -= 1) {
    const bucketStart = bucketStarts[index];
    const row = byBucket.get(bucketStart);
    points[index] = {
      bucketStart,
      added: Number(row?.added ?? 0),
      approved: Number(row?.approved ?? 0),
      rejected: Number(row?.rejected ?? 0),
      backlog: Math.max(0, backlog),
    };
    backlog -= Number(row?.backlogDelta ?? 0);
  }
  return points;
}
