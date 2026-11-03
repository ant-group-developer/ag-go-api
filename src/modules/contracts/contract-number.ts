/** Middle part of every contract number: "Hợp đồng sản xuất nội dung". */
export const CONTRACT_NUMBER_KIND = 'HĐSXND';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Contract number of BR-05: `DDMMYY/HĐSXND/AG-<partner code>` from the signing date
 * (YYYY-MM-DD), e.g. 2026-08-01 and `NHH` → `010826/HĐSXND/AG-NHH`.
 */
export function contractNumberBase(date: string, partnerCode: string): string {
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    throw new Error(`Invalid date ${date}`);
  }
  const [, year, month, day] = match;
  return `${day}${month}${year.slice(2)}/${CONTRACT_NUMBER_KIND}/AG-${partnerCode}`;
}

/** First free number: the base itself, then `-2`, `-3`… (BR-05). */
export function nextContractNumber(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** Number of the next acceptance appendix (BR-07): never reused, imported contracts continue. */
export function nextAppendixNumber(lastAppendixNumber: number): number {
  return Math.max(0, lastAppendixNumber) + 1;
}
