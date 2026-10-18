import { describe, expect, test } from 'bun:test';
import { canonicalJson, payloadHash } from '../../../src/application/payload-hash';
import { hashWagerPayload, type WagerTransactionPayload } from '../../../src/application/wagering/submit-wager-transaction';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';

const payload: WagerTransactionPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  test('sorts keys recursively and omits undefined members', () => {
    expect(canonicalJson({ b: '1', a: { d: '2', c: '3' }, e: undefined })).toBe('{"a":{"c":"3","d":"2"},"b":"1"}');
  });

  test('keeps array order and escapes strings as JSON does', () => {
    expect(canonicalJson({ list: ['b', 'a'], text: 'say "hi"' })).toBe('{"list":["b","a"],"text":"say \\"hi\\""}');
  });
});

describe('payloadHash', () => {
  test('is a SHA-256 hex digest of the canonical JSON', () => {
    expect(payloadHash({ a: '1' })).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash({ a: '1' })).toBe(new Bun.CryptoHasher('sha256').update('{"a":"1"}').digest('hex'));
  });

  test('does not depend on key order', () => {
    const reversed = Object.fromEntries(Object.entries(payload).reverse()) as unknown as WagerTransactionPayload;
    expect(hashWagerPayload(reversed)).toBe(hashWagerPayload(payload));
  });

  test('changes when any business field changes', () => {
    const base = hashWagerPayload(payload);
    expect(hashWagerPayload({ ...payload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(base);
    expect(hashWagerPayload({ ...payload, money: { amount: '25.00', currency: 'USD' } })).not.toBe(base);
    expect(hashWagerPayload({ ...payload, kind: WagerTransactionKind.Win })).not.toBe(base);
    expect(hashWagerPayload({ ...payload, roundId: 'round-988' })).not.toBe(base);
    expect(hashWagerPayload({ ...payload, referenceExternalTransactionId: 'ext-1' })).not.toBe(base);
  });

  test('ignores transport metadata at the top level, with or without a reference', () => {
    const withMeta = { ...payload, messageId: 'm-1', receiveCount: 3 } as unknown as WagerTransactionPayload;
    expect(hashWagerPayload(withMeta)).toBe(hashWagerPayload(payload));
    const reversal = { ...payload, kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-1' };
    expect(hashWagerPayload({ ...reversal, messageId: 'm-2' } as unknown as WagerTransactionPayload)).toBe(
      hashWagerPayload(reversal),
    );
  });

  test('an absent reference and an undefined reference hash the same', () => {
    expect(hashWagerPayload({ ...payload, referenceExternalTransactionId: undefined })).toBe(hashWagerPayload(payload));
  });

  test('ignores fields outside the business payload (extra money keys are dropped)', () => {
    const withExtra = { ...payload, money: { ...payload.money, note: 'x' } } as unknown as WagerTransactionPayload;
    expect(hashWagerPayload(withExtra)).toBe(hashWagerPayload(payload));
  });
});
