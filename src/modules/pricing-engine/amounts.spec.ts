import {
  advanceOffsetFor,
  calculateAmounts,
  divideHalfUp,
  lineAmount,
  MAX_LINE_AMOUNT,
  taxFor,
} from './amounts';
import { PricingError } from './pricing-error';

/** Port of AG Music ReportAmountCalculatorTest, plus the acceptance-record specifics. */
describe('calculateAmounts (AG Music port)', () => {
  it('rounds the default tax to the đồng', () => {
    const amounts = calculateAmounts({ lineAmounts: [700_000, 333_335], taxRatePercent: 10 });
    expect(amounts.gross).toBe(1_033_335);
    expect(amounts.tax).toBe(103_334);
    expect(amounts.net).toBe(930_001);
    expect(amounts.taxOverridden).toBe(false);
    expect(amounts.netWords).toBe('Chín trăm ba mươi nghìn lẻ một đồng');
  });

  it('keeps an overridden tax, even zero', () => {
    const amounts = calculateAmounts({
      lineAmounts: [1_000_000],
      taxRatePercent: 10,
      taxOverride: 0,
    });
    expect(amounts.tax).toBe(0);
    expect(amounts.net).toBe(1_000_000);
    expect(amounts.taxOverridden).toBe(true);
  });

  it('gives zero for an empty record', () => {
    const amounts = calculateAmounts({ lineAmounts: [], taxRatePercent: 10 });
    expect(amounts.gross).toBe(0);
    expect(amounts.netWords).toBe('Không đồng');
  });

  it('rejects invalid amounts and tax', () => {
    expect(() => calculateAmounts({ lineAmounts: [-1], taxRatePercent: 10 })).toThrow(PricingError);
    expect(() => calculateAmounts({ lineAmounts: [10.5], taxRatePercent: 10 })).toThrow(
      PricingError,
    );
    expect(() =>
      calculateAmounts({ lineAmounts: [MAX_LINE_AMOUNT + 1], taxRatePercent: 10 }),
    ).toThrow(PricingError);
    expect(() =>
      calculateAmounts({ lineAmounts: [100], taxRatePercent: 10, taxOverride: 101 }),
    ).toThrow(PricingError);
    expect(() =>
      calculateAmounts({ lineAmounts: Array(200).fill(MAX_LINE_AMOUNT), taxRatePercent: 10 }),
    ).toThrow('Tổng giá trị vượt quá giới hạn.');
    expect(() => calculateAmounts({ lineAmounts: [100], taxRatePercent: 120 })).toThrow(
      PricingError,
    );
    expect(() =>
      calculateAmounts({ lineAmounts: [100], taxRatePercent: 10, advanceOffset: 91 }),
    ).toThrow(PricingError);
  });

  it('takes the advance offset off the net', () => {
    const amounts = calculateAmounts({
      lineAmounts: [18_300_000],
      taxRatePercent: 10,
      advanceOffset: 16_470_000,
    });
    expect(amounts).toMatchObject({ tax: 1_830_000, advanceOffset: 16_470_000, net: 0 });
    expect(amounts.netWords).toBe('Không đồng');
  });
});

describe('rounding helpers', () => {
  it('rounds half up', () => {
    expect(divideHalfUp(15n, 10n)).toBe(2n);
    expect(divideHalfUp(14n, 10n)).toBe(1n);
    expect(divideHalfUp(25n, 10n)).toBe(3n);
  });

  it('computes tax with a decimal rate', () => {
    expect(taxFor(1_300_000, 10)).toBe(130_000);
    expect(taxFor(1_000_005, 10)).toBe(100_001);
    expect(taxFor(1_000_000, 7.5)).toBe(75_000);
    expect(taxFor(5, 10)).toBe(1); // 0,5 → 1
    expect(taxFor(4, 10)).toBe(0);
  });

  it('computes line amounts with decimal quantities', () => {
    expect(lineAmount(61, 300_000)).toBe(18_300_000);
    expect(lineAmount(1.5, 333_333)).toBe(500_000); // 499 999,5 → 500 000
    expect(() => lineAmount(-1, 1)).toThrow(PricingError);
    expect(() => lineAmount(1, -1)).toThrow(PricingError);
    expect(() => lineAmount(2, MAX_LINE_AMOUNT)).toThrow(PricingError);
  });
});

describe('advanceOffsetFor (BR-32)', () => {
  it('TC-4: full_first offsets gross − tax, the rest of the advance stays', () => {
    const offset = advanceOffsetFor({
      rule: 'full_first',
      gross: 18_300_000,
      tax: 1_830_000,
      advanceRemaining: 50_000_000,
      advanceAmount: 50_000_000,
      capAmount: 100_000_000,
    });
    expect(offset).toBe(16_470_000);
    expect(50_000_000 - offset).toBe(33_530_000);
    const amounts = calculateAmounts({
      lineAmounts: [18_300_000],
      taxRatePercent: 10,
      advanceOffset: offset,
    });
    expect(amounts.tax).toBe(1_830_000);
    expect(amounts.net).toBe(0);
  });

  it('full_first is limited by what is left of the advance', () => {
    expect(
      advanceOffsetFor({
        rule: 'full_first',
        gross: 18_300_000,
        tax: 1_830_000,
        advanceRemaining: 5_000_000,
        advanceAmount: 50_000_000,
        capAmount: null,
      }),
    ).toBe(5_000_000);
  });

  it('proportional offsets gross × advance / ceiling, capped', () => {
    const base = { gross: 18_300_000, tax: 1_830_000, advanceAmount: 50_000_000 };
    expect(
      advanceOffsetFor({
        ...base,
        rule: 'proportional',
        advanceRemaining: 50_000_000,
        capAmount: 100_000_000,
      }),
    ).toBe(9_150_000);
    expect(
      advanceOffsetFor({
        ...base,
        rule: 'proportional',
        advanceRemaining: 1_000_000,
        capAmount: 100_000_000,
      }),
    ).toBe(1_000_000);
    // No ceiling: as full_first.
    expect(
      advanceOffsetFor({
        ...base,
        rule: 'proportional',
        advanceRemaining: 50_000_000,
        capAmount: null,
      }),
    ).toBe(16_470_000);
  });

  it('rejects invalid inputs', () => {
    expect(() =>
      advanceOffsetFor({
        rule: 'full_first',
        gross: -1,
        tax: 0,
        advanceRemaining: 0,
        advanceAmount: 0,
        capAmount: null,
      }),
    ).toThrow(PricingError);
  });
});
