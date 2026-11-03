import { PricingError } from './pricing-error';

/**
 * Amount in words, ported from AG Music `VietnameseMoneyWords` (Java), which reads like the legacy
 * `readMoney` of ant-media: drops "không trăm" (`1.000.005` → "Một triệu lẻ năm"), "mươi mốt",
 * "mười lăm", "hai mươi lăm", capitalised first letter. Zero is "Không".
 *
 * AG Music always ends with "đồng chẵn" (the default here, so its test cases hold). AG Go's
 * acceptance records end with "đồng" as the sample records do (spec 6.8 TC-1, D2):
 * use {@link acceptanceMoneyWords}.
 */

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const UNITS = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];

/** Suffix of AG Music and the legacy system. */
export const LEGACY_MONEY_SUFFIX = 'đồng chẵn';
/** Suffix on AG Go acceptance records ("Mười sáu triệu bốn trăm bảy mươi nghìn đồng"). */
export const ACCEPTANCE_MONEY_SUFFIX = 'đồng';

function toDigits(amount: number | bigint | string): string {
  let value: bigint;
  if (typeof amount === 'bigint') {
    value = amount;
  } else if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) {
      throw new PricingError('INVALID_AMOUNT', `Số tiền phải là số nguyên không âm: ${amount}`);
    }
    value = BigInt(amount);
  } else {
    const trimmed = amount.trim();
    // Accept "1000", "1000.00" (no fractional part), like BigDecimal.stripTrailingZeros().
    const match = /^(-?\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!match || (match[2] !== undefined && /[1-9]/.test(match[2]))) {
      throw new PricingError('INVALID_AMOUNT', `Số tiền phải là số nguyên không âm: ${amount}`);
    }
    value = BigInt(match[1]);
  }
  if (value < 0n) {
    throw new PricingError('INVALID_AMOUNT', `Số tiền phải là số nguyên không âm: ${amount}`);
  }
  const digits = value.toString();
  if (digits.length > UNITS.length * 3) {
    throw new PricingError('INVALID_AMOUNT', `Số tiền quá lớn: ${amount}`);
  }
  return digits;
}

/** One group 1–999 without "không trăm"; a non-leading `005` reads "lẻ năm". */
function readGroup(value: number, leading: boolean): string {
  const hundreds = Math.floor(value / 100);
  const tens = Math.floor(value / 10) % 10;
  const units = value % 10;
  const words: string[] = [];
  if (hundreds > 0) {
    words.push(DIGITS[hundreds], 'trăm');
  }
  if (tens === 0) {
    if (units > 0) {
      if (hundreds > 0 || !leading) {
        words.push('lẻ');
      }
      words.push(DIGITS[units]);
    }
    return words.join(' ');
  }
  words.push(tens === 1 ? 'mười' : `${DIGITS[tens]} mươi`);
  if (units === 5) {
    words.push('lăm');
  } else if (units === 1 && tens > 1) {
    words.push('mốt');
  } else if (units > 0) {
    words.push(DIGITS[units]);
  }
  return words.join(' ');
}

/**
 * Words of a whole, non-negative amount in đồng, up to 999 triệu tỷ.
 * @throws PricingError INVALID_AMOUNT when negative, fractional or too large
 */
export function vietnameseMoneyWords(
  amount: number | bigint | string,
  suffix: string = LEGACY_MONEY_SUFFIX,
): string {
  const digits = toDigits(amount);
  const groups = Math.ceil(digits.length / 3);
  const padded = digits.padStart(groups * 3, '0');
  const words: string[] = [];
  for (let group = 0; group < groups; group += 1) {
    const value = Number(padded.slice(group * 3, group * 3 + 3));
    if (value === 0) {
      continue;
    }
    words.push(readGroup(value, words.length === 0));
    const unit = UNITS[groups - group - 1];
    if (unit) {
      words.push(unit);
    }
  }
  const text = words.length === 0 ? 'không' : words.join(' ');
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return suffix ? `${sentence} ${suffix}` : sentence;
}

/** Words as printed on an acceptance record: "… đồng" (spec 6.8). */
export function acceptanceMoneyWords(amount: number | bigint | string): string {
  return vietnameseMoneyWords(amount, ACCEPTANCE_MONEY_SUFFIX);
}
