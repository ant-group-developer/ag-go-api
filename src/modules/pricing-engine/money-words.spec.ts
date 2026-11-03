import { ACCEPTANCE_MONEY_SUFFIX, acceptanceMoneyWords, vietnameseMoneyWords } from './money-words';
import { PricingError } from './pricing-error';

/** Port of AG Music VietnameseMoneyWordsTest: reads like the legacy `readMoney` (ant-media). */
describe('vietnameseMoneyWords (AG Music port)', () => {
  it.each([
    ['0', 'Không đồng chẵn'],
    ['5', 'Năm đồng chẵn'],
    ['10', 'Mười đồng chẵn'],
    ['15', 'Mười lăm đồng chẵn'],
    ['21', 'Hai mươi mốt đồng chẵn'],
    ['25', 'Hai mươi lăm đồng chẵn'],
    ['105', 'Một trăm lẻ năm đồng chẵn'],
    ['110', 'Một trăm mười đồng chẵn'],
    ['1000', 'Một nghìn đồng chẵn'],
    ['1000005', 'Một triệu lẻ năm đồng chẵn'],
    ['1005000', 'Một triệu lẻ năm nghìn đồng chẵn'],
    ['15120000', 'Mười lăm triệu một trăm hai mươi nghìn đồng chẵn'],
    ['1000000000', 'Một tỷ đồng chẵn'],
    ['2500000000', 'Hai tỷ năm trăm triệu đồng chẵn'],
    ['1000000000000', 'Một nghìn tỷ đồng chẵn'],
  ])('reads %s like the legacy system', (amount, words) => {
    expect(vietnameseMoneyWords(amount)).toBe(words);
  });

  it.each(['-1', '1.5', '1000000000000000000', 'abc'])('rejects %s', (amount) => {
    expect(() => vietnameseMoneyWords(amount)).toThrow(PricingError);
  });

  it('accepts numbers, bigints and decimals without a fractional part', () => {
    expect(vietnameseMoneyWords(930_001)).toBe('Chín trăm ba mươi nghìn lẻ một đồng chẵn');
    expect(vietnameseMoneyWords(999_999_999_999_999_999n)).toMatch(
      /^Chín trăm chín mươi chín triệu tỷ/,
    );
    expect(vietnameseMoneyWords('1000.00')).toBe('Một nghìn đồng chẵn');
    expect(() => vietnameseMoneyWords(1.5)).toThrow(PricingError);
    expect(() => vietnameseMoneyWords(-3)).toThrow(PricingError);
  });

  it('takes another suffix, or none', () => {
    expect(vietnameseMoneyWords(21, '')).toBe('Hai mươi mốt');
    expect(vietnameseMoneyWords(21, ACCEPTANCE_MONEY_SUFFIX)).toBe('Hai mươi mốt đồng');
  });
});

/** Acceptance records end with "đồng" (spec 6.8, BR-33). */
describe('acceptanceMoneyWords', () => {
  it.each([
    [65_250_000, 'Sáu mươi lăm triệu hai trăm năm mươi nghìn đồng'],
    [16_470_000, 'Mười sáu triệu bốn trăm bảy mươi nghìn đồng'],
    [1_170_000, 'Một triệu một trăm bảy mươi nghìn đồng'],
    [72_500_000, 'Bảy mươi hai triệu năm trăm nghìn đồng'],
    [0, 'Không đồng'],
    [101_014, 'Một trăm lẻ một nghìn mười bốn đồng'],
  ])('%d → %s', (amount, words) => {
    expect(acceptanceMoneyWords(amount)).toBe(words);
  });
});
