import {
  formatDate,
  formatLongDate,
  formatMoney,
  formatNumber,
  vietnamDay,
} from './document-format';

describe('document formats (spec 13)', () => {
  it('prints dates dd/MM/yyyy from ISO dates, timestamps and Vietnamese dates', () => {
    expect(formatDate('2026-10-07')).toBe('07/10/2026');
    expect(formatDate('2026-10-07T03:00:00.000Z')).toBe('07/10/2026');
    expect(formatDate('07/10/2026')).toBe('07/10/2026');
    expect(formatDate(null)).toBe('');
    expect(formatDate(' không rõ ')).toBe('không rõ');
  });

  it('prints long dates "ngày 07 tháng 10 năm 2026"', () => {
    expect(formatLongDate('2026-10-07')).toBe('ngày 07 tháng 10 năm 2026');
    expect(formatLongDate('01/02/2027')).toBe('ngày 01 tháng 02 năm 2027');
    expect(formatLongDate(undefined)).toBe('');
    expect(formatLongDate('sai')).toBe('');
  });

  it('groups money with dots (vi-VN)', () => {
    expect(formatMoney(72_500_000)).toBe('72.500.000');
    expect(formatMoney(1_300_000)).toBe('1.300.000');
    expect(formatMoney(999)).toBe('999');
    expect(formatMoney(0)).toBe('0');
    expect(formatMoney(-7_250_000)).toBe('-7.250.000');
    expect(formatMoney(12_345_678_901_234n)).toBe('12.345.678.901.234');
    expect(formatMoney('0065250000')).toBe('65.250.000');
    expect(formatMoney(null)).toBe('');
    expect(() => formatMoney(1.5)).toThrow('Not a whole amount');
  });

  it('prints quantities with a decimal comma', () => {
    expect(formatNumber(29)).toBe('29');
    expect(formatNumber(2.5)).toBe('2,5');
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(formatNumber('10')).toBe('10');
    expect(formatNumber(null)).toBe('');
    expect(formatNumber('abc')).toBe('abc');
  });

  it('takes the day in Vietnam', () => {
    expect(vietnamDay(new Date('2026-10-06T18:30:00Z'))).toBe('2026-10-07');
  });
});
