import { describe, expect, test } from 'bun:test';
import { MAX_SCAN_DEPTH, scanLogLine } from '../helpers/scan-log-line';

const PATTERNS = [/40P01/, /deadlock detected/i, /\b(wallets_balance_non_negative)\b/];
const line = (entry: unknown): string => JSON.stringify(entry);
const nested = (depth: number, leaf: unknown): unknown => (depth === 0 ? leaf : { next: nested(depth - 1, leaf) });

describe('scanLogLine', () => {
  test('linha JSON de nível error com valor proibido num campo de texto é detectada', () => {
    expect(scanLogLine(line({ level: 'error', message: 'x', constraint: 'wallets_balance_non_negative' }), PATTERNS)).toBe(true);
    expect(scanLogLine(line({ level: 'error', message: 'x', sqlState: '40P01' }), PATTERNS)).toBe(true);
  });

  test('level warn com valor proibido em campo aninhado em objeto ou array', () => {
    expect(scanLogLine(line({ level: 'warn', context: { cause: { detail: 'deadlock detected' } } }), PATTERNS)).toBe(true);
    expect(scanLogLine(line({ level: 'warn', list: [1, ['x', 'wallets_balance_non_negative']] }), PATTERNS)).toBe(true);
  });

  test('o valor proibido só como chave, ou em número, não é achado', () => {
    expect(scanLogLine(line({ level: 'error', '40P01': 'ok', n: 40 }), PATTERNS)).toBe(false);
  });

  test('linha JSON limpa de nível error não é achado', () => {
    expect(scanLogLine(line({ level: 'error', message: 'Request failed', sqlState: '23505' }), PATTERNS)).toBe(false);
  });

  test('níveis que não são de falha não são examinados (info, debug, verbose)', () => {
    for (const level of ['info', 'debug', 'verbose']) {
      expect(scanLogLine(line({ level, constraint: 'wallets_balance_non_negative' }), PATTERNS)).toBe(false);
    }
  });

  test('linha que não é JSON segue a regra antiga, inclusive a truncada, sem lançar', () => {
    expect(scanLogLine('error: deadlock detected', PATTERNS)).toBe(true);
    expect(scanLogLine('error: all fine', PATTERNS)).toBe(false);
    const truncated = line({ level: 'info', message: 'x', constraint: 'wallets_balance_non_negative' }).slice(0, -2);
    expect(() => scanLogLine(truncated, PATTERNS)).not.toThrow();
    expect(scanLogLine(truncated, PATTERNS)).toBe(true); // a regra antiga olha a linha inteira
    expect(scanLogLine('{"level":"error","message":"40P0', PATTERNS)).toBe(false);
  });

  test('JSON sem level válido, ou que não é objeto, segue a regra antiga', () => {
    expect(scanLogLine(line({ message: '40P01' }), PATTERNS)).toBe(true);
    expect(scanLogLine(line({ level: 'bogus', message: '40P01' }), PATTERNS)).toBe(true);
    expect(scanLogLine(line({ level: 7, message: '40P01' }), PATTERNS)).toBe(true);
    expect(scanLogLine(line(['40P01']), PATTERNS)).toBe(true);
    expect(scanLogLine('"40P01"', PATTERNS)).toBe(true);
    expect(scanLogLine('40', PATTERNS)).toBe(false);
  });

  test('profundidade: no limite varre, além do limite conta como achado', () => {
    const within = { level: 'error', data: nested(MAX_SCAN_DEPTH - 2, 'clean') };
    expect(scanLogLine(line(within), PATTERNS)).toBe(false);
    expect(scanLogLine(line({ level: 'error', data: nested(MAX_SCAN_DEPTH - 2, '40P01') }), PATTERNS)).toBe(true);
    const beyond = { level: 'error', data: nested(MAX_SCAN_DEPTH + 2, 'clean') };
    expect(scanLogLine(line(beyond), PATTERNS)).toBe(true);
  });
});
