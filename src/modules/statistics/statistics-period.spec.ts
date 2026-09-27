import { BadRequestException } from '@nestjs/common';
import { resolveStatisticsPeriod, toPeriodInfo } from './statistics-period';

describe('resolveStatisticsPeriod', () => {
  const now = new Date('2026-09-27T05:00:00.000Z');

  it('compares a running month with the same elapsed span of the previous window', () => {
    const period = resolveStatisticsPeriod(
      { from: '2026-08-31T17:00:00.000Z', to: '2026-09-30T17:00:00.000Z' },
      now,
    );

    expect(period.effectiveTo).toEqual(now);
    expect(period.previousFrom.toISOString()).toBe('2026-08-01T17:00:00.000Z');
    expect(period.previousTo.toISOString()).toBe('2026-08-28T05:00:00.000Z');
    expect(period.granularity).toBe('day');
    expect(period.timeZone).toBe('Asia/Ho_Chi_Minh');
  });

  it('keeps a finished window whole and uses the requested time zone', () => {
    const period = resolveStatisticsPeriod(
      { from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z', tz: 'UTC' },
      now,
    );

    expect(period.effectiveTo.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(period.previousFrom.toISOString()).toBe('2026-08-25T00:00:00.000Z');
    expect(period.previousTo.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(toPeriodInfo(period).timeZone).toBe('UTC');
  });

  it('gives a future window no elapsed time', () => {
    const period = resolveStatisticsPeriod(
      { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
      now,
    );

    expect(period.effectiveTo).toEqual(period.from);
    expect(period.previousTo).toEqual(period.previousFrom);
  });

  it('groups by week above 62 days', () => {
    const daily = resolveStatisticsPeriod(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-03-04T00:00:00.000Z' },
      now,
    );
    const weekly = resolveStatisticsPeriod(
      { from: '2026-01-01T00:00:00.000Z', to: '2026-03-05T00:00:00.000Z' },
      now,
    );

    expect(daily.granularity).toBe('day');
    expect(weekly.granularity).toBe('week');
  });

  it.each([
    ['from after to', '2026-09-02T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    ['empty window', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    ['longer than two years', '2024-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'],
    ['invalid date', 'not-a-date', '2026-09-01T00:00:00.000Z'],
  ])('rejects %s', (_label, from, to) => {
    expect(() => resolveStatisticsPeriod({ from, to }, now)).toThrow(BadRequestException);
  });
});
