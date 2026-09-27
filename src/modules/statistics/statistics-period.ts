import { BadRequestException } from '@nestjs/common';
import type { StatisticsGranularity, StatisticsPeriodInfo } from './statistics.types';

export const DEFAULT_STATISTICS_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 731;
/** Longer periods are grouped by ISO week so the trend chart stays readable. */
const MAX_DAILY_RANGE_DAYS = 62;

export type StatisticsPeriod = {
  from: Date;
  to: Date;
  /** `to` clamped to now: a period still in progress is only counted up to this moment. */
  effectiveTo: Date;
  previousFrom: Date;
  previousTo: Date;
  granularity: StatisticsGranularity;
  timeZone: string;
};

/**
 * Resolves the requested window and the previous window it is compared with. The previous window
 * has the same length and covers the same elapsed span, so "this month so far" is compared with
 * the same number of days at the start of last month instead of the whole of last month.
 */
export function resolveStatisticsPeriod(
  input: { from: string; to: string; tz?: string },
  now: Date = new Date(),
): StatisticsPeriod {
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestException('Invalid statistics period');
  }
  if (from >= to) {
    throw new BadRequestException('`from` must be before `to`');
  }
  const length = to.getTime() - from.getTime();
  if (length > MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestException(`The statistics period cannot exceed ${MAX_RANGE_DAYS} days`);
  }

  const effectiveTo = new Date(Math.max(from.getTime(), Math.min(to.getTime(), now.getTime())));
  return {
    from,
    to,
    effectiveTo,
    previousFrom: new Date(from.getTime() - length),
    previousTo: new Date(effectiveTo.getTime() - length),
    granularity: length > MAX_DAILY_RANGE_DAYS * DAY_MS ? 'week' : 'day',
    timeZone: input.tz ?? DEFAULT_STATISTICS_TIME_ZONE,
  };
}

export function toPeriodInfo(period: StatisticsPeriod): StatisticsPeriodInfo {
  return {
    from: period.from.toISOString(),
    to: period.to.toISOString(),
    effectiveTo: period.effectiveTo.toISOString(),
    previousFrom: period.previousFrom.toISOString(),
    previousTo: period.previousTo.toISOString(),
    granularity: period.granularity,
    timeZone: period.timeZone,
  };
}
