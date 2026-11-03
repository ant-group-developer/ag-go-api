/**
 * Formats of values printed on contracts and acceptance records (spec 13): dates `dd/MM/yyyy` and
 * "ngày 07 tháng 10 năm 2026", money `72.500.000` (vi-VN grouping, whole đồng). Pure functions.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const VN_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

type DateParts = { year: string; month: string; day: string };

/** `2026-10-07`, `2026-10-07T…` or `07/10/2026`; anything else is null. */
function dateParts(value: string | null | undefined): DateParts | null {
  if (!value) {
    return null;
  }
  const text = value.trim();
  const iso = ISO_DATE.exec(text);
  if (iso) {
    return { year: iso[1], month: iso[2], day: iso[3] };
  }
  const vn = VN_DATE.exec(text);
  if (vn) {
    return { year: vn[3], month: vn[2], day: vn[1] };
  }
  return null;
}

/** `2026-10-07` → `07/10/2026`; a value that is not a date is returned as is (trimmed). */
export function formatDate(value: string | null | undefined): string {
  const parts = dateParts(value);
  if (!parts) {
    return value?.trim() ?? '';
  }
  return `${parts.day}/${parts.month}/${parts.year}`;
}

/** `2026-10-07` → `ngày 07 tháng 10 năm 2026` (empty when not a date). */
export function formatLongDate(value: string | null | undefined): string {
  const parts = dateParts(value);
  if (!parts) {
    return '';
  }
  return `ngày ${parts.day} tháng ${parts.month} năm ${parts.year}`;
}

/** `72500000` → `72.500.000`; negative amounts keep their sign. Null → empty. */
export function formatMoney(value: number | bigint | string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`Not a whole amount: ${text}`);
  }
  const negative = text.startsWith('-');
  const digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, '');
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return negative ? `-${grouped}` : grouped;
}

/** Quantities and percents: `29` → `29`, `2.5` → `2,5`, `1234.5` → `1.234,5`. */
export function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  const [whole, fraction] = String(Math.round(number * 100) / 100).split('.');
  const grouped = formatMoney(whole);
  return fraction ? `${grouped},${fraction}` : grouped;
}

/** Day of `date` in Vietnam (YYYY-MM-DD), the day printed on documents made now. */
export function vietnamDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
