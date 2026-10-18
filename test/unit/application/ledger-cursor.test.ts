import { describe, expect, test } from 'bun:test';
import { InvalidCursorError } from '../../../src/application/errors';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../../src/application/wallets/ledger-cursor';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

describe('ledger cursor', () => {
  test('round-trips versions, including the INTEGER maximum', () => {
    for (const version of [1, 2, 9, 10, 12345, 2_147_483_647]) {
      expect(decodeLedgerCursor(encodeLedgerCursor(version))).toBe(version);
    }
  });

  test('is opaque: base64url of the decimal version, no padding', () => {
    expect(encodeLedgerCursor(5)).toBe('NQ');
  });

  test.each([
    ['empty', ''],
    ['not a string', 5],
    ['plain number', '5'],
    ['standard base64 padding', 'NQ=='],
    ['non-base64 characters', 'N Q'],
    ['version prefix', b64('v:5')],
    ['named prefix', b64('version:5')],
    ['zero', b64('0')],
    ['negative', b64('-1')],
    ['leading zero', b64('05')],
    ['decimal', b64('1.5')],
    ['exponent', b64('1e3')],
    ['above INTEGER', b64('2147483648')],
    ['too many digits', b64('12345678901')],
    ['non-canonical base64 (stray bits)', 'NR'],
  ])('rejects %s', (_name, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidCursorError);
  });
});
