/** Partner codes: upper-case letters and digits, as used in contract numbers. */
export const PARTNER_CODE_PATTERN = /^[A-Z0-9]{1,20}$/;

const MAX_CODE_LENGTH = 20;

/**
 * Default partner code (BR-06): first letter of each word of the full name, without diacritics,
 * upper case. `Nguyễn Hữu Hoàng` → `NHH`, `Đỗ Văn A` → `DVA`. Falls back to `CTV` when the name has
 * no letter.
 */
export function partnerCodeBase(fullName: string): string {
  const initials = fullName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'D')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase())
    .join('');
  return (initials || 'CTV').slice(0, MAX_CODE_LENGTH - 3);
}

/** First free code: the base itself, then `NHH2`, `NHH3`… (BR-06). */
export function nextPartnerCode(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((code) => code.toUpperCase()));
  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}
