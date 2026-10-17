import { describe, expect, test } from 'bun:test';
import {
  parseCreateWalletRequest,
  parseIdempotencyKey,
  parseWagerTransactionPayload,
  RequestValidationError,
} from '../../../src/interface/http/validation';

const valid = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192F291-27DD-7D3F-8071-5F8685DEEF37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

function detailsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestValidationError) return error.details;
    throw error;
  }
  throw new Error('expected a RequestValidationError');
}

describe('parseWagerTransactionPayload', () => {
  test('accepts the challenge example and normalizes UUIDs to lowercase', () => {
    expect(parseWagerTransactionPayload(valid)).toEqual({ ...valid, walletId: valid.walletId.toLowerCase() } as never);
  });

  test('keeps referenceExternalTransactionId only when present', () => {
    const win = parseWagerTransactionPayload({ ...valid, kind: 'WIN', referenceExternalTransactionId: 'bet-1' });
    expect(win.referenceExternalTransactionId).toBe('bet-1');
    expect('referenceExternalTransactionId' in parseWagerTransactionPayload(valid)).toBe(false);
  });

  test.each([
    [{ money: { amount: 25, currency: 'BRL' } }],
    [{ money: { amount: '25', currency: 'BRL' } }],
    [{ money: { amount: '1e3', currency: 'BRL' } }],
    [{ money: { amount: '025.00', currency: 'BRL' } }],
    [{ money: { amount: '25.00', currency: 'BRL', scale: 2 } }],
    [{ money: '25.00' }],
  ])('rejects money %j', (override) => {
    expect(() => parseWagerTransactionPayload({ ...valid, ...override })).toThrow(RequestValidationError);
  });

  test('rejects OPENING, the reserved provider and unknown fields, listing every problem', () => {
    expect(detailsOf(() => parseWagerTransactionPayload({ ...valid, kind: 'OPENING', providerId: 'INTERNAL', extra: 1 })))
      .toEqual([
        'extra is not allowed',
        'providerId "internal" is reserved',
        'kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK',
      ]);
  });

  test('REFUND and ROLLBACK require a reference; BET cannot have one', () => {
    expect(() => parseWagerTransactionPayload({ ...valid, kind: 'REFUND' })).toThrow(RequestValidationError);
    expect(() => parseWagerTransactionPayload({ ...valid, kind: 'ROLLBACK' })).toThrow(RequestValidationError);
    expect(() => parseWagerTransactionPayload({ ...valid, referenceExternalTransactionId: 'x' })).toThrow(
      RequestValidationError,
    );
  });

  test('rejects ids that are too long, empty or not UUIDs', () => {
    expect(() => parseWagerTransactionPayload({ ...valid, roundId: 'r'.repeat(129) })).toThrow(RequestValidationError);
    expect(() => parseWagerTransactionPayload({ ...valid, gameId: '  ' })).toThrow(RequestValidationError);
    expect(() => parseWagerTransactionPayload({ ...valid, playerId: 'player-1' })).toThrow(RequestValidationError);
  });

  test.each([[null], [[]], ['text'], [42]])('rejects a non-object body (%j)', (body) => {
    expect(() => parseWagerTransactionPayload(body)).toThrow(RequestValidationError);
  });
});

describe('parseIdempotencyKey', () => {
  test('accepts 1 to 255 visible ASCII characters', () => {
    expect(parseIdempotencyKey('provider-a:transaction-123')).toBe('provider-a:transaction-123');
    expect(parseIdempotencyKey('k'.repeat(255))).toHaveLength(255);
  });

  test.each([undefined, '', 'k'.repeat(256), 'has space', 'acentuação', 'internal:opening:x', 'Internal:x'])(
    'rejects %p',
    (key) => {
      expect(() => parseIdempotencyKey(key)).toThrow(RequestValidationError);
    },
  );
});

describe('parseCreateWalletRequest', () => {
  test('accepts a zero initial balance', () => {
    const request = parseCreateWalletRequest({ playerId: valid.playerId, initialBalance: { amount: '0.00', currency: 'BRL' } });
    expect(request.initialBalance).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('requires the initial balance', () => {
    expect(detailsOf(() => parseCreateWalletRequest({ playerId: valid.playerId }))).toEqual([
      'initialBalance must be an object',
    ]);
  });
});
