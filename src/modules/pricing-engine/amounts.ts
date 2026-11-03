import { acceptanceMoneyWords } from './money-words';
import { PricingError } from './pricing-error';

/**
 * Money of an acceptance record, in whole đồng (NFR-02), ported from AG Music
 * `ReportAmountCalculator`: gross = Σ line amounts, default tax = round(gross × rate) HALF_UP to the
 * đồng, the preparer may type the tax (0 ≤ tax ≤ gross), net = gross − tax − advance offset.
 */

/** Largest line amount (13 digits), as AG Music. */
export const MAX_LINE_AMOUNT = 9_999_999_999_999;
/** Largest gross (15 digits, still a safe integer). */
export const MAX_GROSS_AMOUNT = 999_999_999_999_999;

function requireMoney(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PricingError('INVALID_AMOUNT', `${label} phải là số nguyên không âm (đồng).`);
  }
}

/** numerator / denominator rounded HALF_UP, both non-negative. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** A percentage with at most 2 decimals (numeric(5,2)) as hundredths of a percent. */
function basisPoints(ratePercent: number): bigint {
  if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw new PricingError('INVALID_INPUT', `Tỷ lệ thuế không hợp lệ: ${ratePercent}`);
  }
  return BigInt(Math.round(ratePercent * 100));
}

/** round(gross × ratePercent / 100) HALF_UP, in đồng. */
export function taxFor(gross: number, ratePercent: number): number {
  requireMoney(gross, 'Tổng giá trị');
  return Number(divideHalfUp(BigInt(gross) * basisPoints(ratePercent), 10_000n));
}

/**
 * Amount of a line: quantity (numeric(12,2), may be adjusted to a decimal) × unit price, rounded
 * HALF_UP to the đồng.
 */
export function lineAmount(quantity: number, unitPrice: number): number {
  requireMoney(unitPrice, 'Đơn giá');
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new PricingError('INVALID_INPUT', `Khối lượng không hợp lệ: ${quantity}`);
  }
  const hundredths = BigInt(Math.round(quantity * 100));
  const amount = Number(divideHalfUp(hundredths * BigInt(unitPrice), 100n));
  if (amount > MAX_LINE_AMOUNT) {
    throw new PricingError('INVALID_AMOUNT', `Thành tiền một dòng tối đa ${MAX_LINE_AMOUNT} đồng.`);
  }
  return amount;
}

export type AdvanceOffsetRule = 'full_first' | 'proportional';

export type AdvanceOffsetInput = {
  rule: AdvanceOffsetRule;
  gross: number;
  tax: number;
  /** Advance not yet offset against earlier acceptance records. */
  advanceRemaining: number;
  /** Agreed advance and contract ceiling, for `proportional`. */
  advanceAmount: number;
  capAmount: number | null;
};

/**
 * Advance offset of one acceptance record (BR-32, Q6 assumption: tax on the gross):
 * - `full_first`: as much of the remaining advance as fits in gross − tax;
 * - `proportional`: gross × advance / ceiling (HALF_UP), also capped by the remaining advance and
 *   gross − tax; without a ceiling it falls back to `full_first`.
 */
export function advanceOffsetFor(input: AdvanceOffsetInput): number {
  requireMoney(input.gross, 'Tổng giá trị');
  requireMoney(input.tax, 'Thuế');
  requireMoney(input.advanceRemaining, 'Tạm ứng còn lại');
  requireMoney(input.advanceAmount, 'Tạm ứng');
  const room = Math.max(0, input.gross - input.tax);
  const limit = Math.min(room, input.advanceRemaining);
  if (input.rule === 'proportional' && input.capAmount !== null && input.capAmount > 0) {
    const share = Number(
      divideHalfUp(BigInt(input.gross) * BigInt(input.advanceAmount), BigInt(input.capAmount)),
    );
    return Math.min(limit, share);
  }
  return limit;
}

export type AmountsInput = {
  lineAmounts: readonly number[];
  /** Tax rate of the record in percent (numeric(5,2)), default 10. */
  taxRatePercent: number;
  /** Tax typed by the preparer; null / undefined = computed from the rate. */
  taxOverride?: number | null;
  /** Advance offset (computed by advanceOffsetFor or typed); default 0. */
  advanceOffset?: number;
};

export type Amounts = {
  gross: number;
  taxRatePercent: number;
  tax: number;
  taxOverridden: boolean;
  advanceOffset: number;
  /** gross − tax − advance offset (never negative). */
  net: number;
  netWords: string;
};

/** Totals of a record. @throws PricingError on negative / fractional / too large amounts. */
export function calculateAmounts(input: AmountsInput): Amounts {
  let gross = 0;
  for (const amount of input.lineAmounts) {
    requireMoney(amount, 'Thành tiền');
    if (amount > MAX_LINE_AMOUNT) {
      throw new PricingError(
        'INVALID_AMOUNT',
        `Thành tiền một dòng tối đa ${MAX_LINE_AMOUNT} đồng.`,
      );
    }
    gross += amount;
  }
  if (gross > MAX_GROSS_AMOUNT) {
    throw new PricingError('INVALID_AMOUNT', 'Tổng giá trị vượt quá giới hạn.');
  }
  const overridden = input.taxOverride !== undefined && input.taxOverride !== null;
  let tax: number;
  if (overridden) {
    tax = input.taxOverride as number;
    requireMoney(tax, 'Thuế');
    if (tax > gross) {
      throw new PricingError('INVALID_AMOUNT', 'Thuế không được lớn hơn tổng giá trị.');
    }
  } else {
    tax = taxFor(gross, input.taxRatePercent);
  }
  const advanceOffset = input.advanceOffset ?? 0;
  requireMoney(advanceOffset, 'Đối trừ tạm ứng');
  if (advanceOffset > gross - tax) {
    throw new PricingError(
      'INVALID_AMOUNT',
      'Đối trừ tạm ứng không được lớn hơn tổng giá trị trừ thuế.',
    );
  }
  const net = gross - tax - advanceOffset;
  return {
    gross,
    taxRatePercent: input.taxRatePercent,
    tax,
    taxOverridden: overridden,
    advanceOffset,
    net,
    netWords: acceptanceMoneyWords(net),
  };
}
