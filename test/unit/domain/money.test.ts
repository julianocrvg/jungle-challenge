import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  test.each(['0.00', '25.00', '0.01', '1234567.89', '99999999999999999.99'])('accepts %p', (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
  });

  test.each([
    ['empty', ''],
    ['no decimals', '25'],
    ['one decimal', '25.5'],
    ['three decimals', '25.001'],
    ['negative', '-1.00'],
    ['explicit plus', '+1.00'],
    ['scientific notation', '1e3'],
    ['scientific with decimals', '1.00e2'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['leading zeros', '01.00'],
    ['comma separator', '25,00'],
    ['surrounding spaces', ' 25.00 '],
    ['hex', '0x10'],
    ['more than 17 integer digits', '100000000000000000.00'],
  ])('rejects %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejects a non-string amount (JSON number)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'B1L'])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  test('is exact where binary floats are not (0.10 + 0.20 = 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('accumulates many small amounts without drift', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.toJSON().amount).toBe('10.00');
  });

  test('always serializes with 2 places', () => {
    expect(brl('1.50').add(brl('1.50')).toJSON().amount).toBe('3.00');
    expect(Money.zero('BRL').toJSON().amount).toBe('0.00');
  });

  test('subtract and negate may go below zero but never mutate the operands', () => {
    const a = brl('1.00');
    const b = brl('2.50');
    expect(a.subtract(b).toJSON().amount).toBe('-1.50');
    expect(a.subtract(b).isNegative()).toBe(true);
    expect(a.negate().toJSON().amount).toBe('-1.00');
    expect(a.toJSON().amount).toBe('1.00');
    expect(b.toJSON().amount).toBe('2.50');
  });

  test('comparisons', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
  });

  test('toString includes the currency', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });
});

describe('Money currency conflicts', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test('add, subtract and isLessThan across currencies throw', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('equals is false (not an error) across currencies', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
  });
});
