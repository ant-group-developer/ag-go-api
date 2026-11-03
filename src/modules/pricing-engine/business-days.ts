import { PricingError } from './pricing-error';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: string): Date {
  const match = DATE.exec(date);
  if (!match) {
    throw new PricingError('INVALID_INPUT', `Ngày không hợp lệ: ${date}`);
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `date` + `days` business days (BR-34): Saturdays, Sundays and the given holidays (YYYY-MM-DD) do
 * not count. 0 days returns the date itself.
 */
export function addBusinessDays(
  date: string,
  days: number,
  holidays: ReadonlySet<string> = new Set(),
): string {
  if (!Number.isInteger(days) || days < 0) {
    throw new PricingError('INVALID_INPUT', `Số ngày làm việc không hợp lệ: ${days}`);
  }
  const current = parse(date);
  let left = days;
  while (left > 0) {
    current.setUTCDate(current.getUTCDate() + 1);
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(format(current))) {
      left -= 1;
    }
  }
  return format(current);
}

/** The day before `date` (YYYY-MM-DD). */
export function previousDay(date: string): string {
  const current = parse(date);
  current.setUTCDate(current.getUTCDate() - 1);
  return format(current);
}
