import { describe, expect, test } from 'bun:test';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  InboxMessageConflictError,
  InvalidCommandError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { hashInboxMessage, hashWagerPayload } from '../../../src/application/wagering/submit-wager-transaction';
import { parseWagerTransactionPayload } from '../../../src/interface/http/validation';
import { classifyFailure, type FailureReason } from '../../../src/interface/messaging/failure-classification';
import { InvalidMessageError, parseWagerMessage } from '../../../src/interface/messaging/wager-message';

// O exemplo da seção 10 do enunciado.
const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const envelope = { messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data };
const body = (override: Record<string, unknown> = {}): string => JSON.stringify({ ...envelope, ...override });

function reasonOf(raw: string): [string, string[]] {
  try {
    parseWagerMessage(raw);
  } catch (error) {
    if (error instanceof InvalidMessageError) return [error.reason, error.details];
    throw error;
  }
  throw new Error('expected an InvalidMessageError');
}

describe('parseWagerMessage', () => {
  test('accepts the challenge example', () => {
    const message = parseWagerMessage(body());
    expect(message.messageId).toBe('msg-123');
    expect(message.idempotencyKey).toBe('provider-a:transaction-123');
    expect(message.occurredAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
    expect(message.payload.kind).toBe('BET' as never);
  });

  test('payloadHash is identical to the HTTP one: messageId, type, occurredAt and idempotencyKey stay out', () => {
    const { idempotencyKey: _, ...httpBody } = data;
    const fromHttp = hashWagerPayload(parseWagerTransactionPayload(httpBody));
    const a = parseWagerMessage(body());
    const b = parseWagerMessage(body({ messageId: 'other', occurredAt: '2030-01-01T00:00:00Z' }));
    const c = parseWagerMessage(body({ data: { ...data, idempotencyKey: 'another-key' } }));
    expect(hashWagerPayload(a.payload)).toBe(fromHttp);
    expect(hashWagerPayload(b.payload)).toBe(fromHttp);
    expect(hashWagerPayload(c.payload)).toBe(fromHttp);
  });

  test('inbox hash covers the key and differs from the payloadHash', () => {
    const { payload } = parseWagerMessage(body());
    expect(hashInboxMessage('k1', payload)).not.toBe(hashWagerPayload(payload));
    expect(hashInboxMessage('k1', payload)).not.toBe(hashInboxMessage('k2', payload));
    expect(hashInboxMessage('k1', payload)).toBe(hashInboxMessage('k1', { ...payload }));
  });

  test('missing idempotencyKey defaults to {providerId}:{externalTransactionId}', () => {
    const { idempotencyKey: _, ...withoutKey } = data;
    expect(parseWagerMessage(body({ data: withoutKey })).idempotencyKey).toBe('provider-a:transaction-123');
  });

  test.each([
    ['not json', 'INVALID_JSON'],
    ['[]', 'INVALID_ENVELOPE'],
    [body({ messageId: '' }), 'INVALID_ENVELOPE'],
    [body({ occurredAt: 'yesterday' }), 'INVALID_ENVELOPE'],
    [body({ data: 'x' }), 'INVALID_ENVELOPE'],
    [body({ extra: 1 }), 'INVALID_ENVELOPE'],
    [body({ type: 'WalletCreated' }), 'UNKNOWN_MESSAGE_TYPE'],
    [body({ data: { ...data, kind: 'OPENING' } }), 'INVALID_PAYLOAD'],
    [body({ data: { ...data, providerId: 'internal' } }), 'INVALID_PAYLOAD'],
    [body({ data: { ...data, money: { amount: 25, currency: 'BRL' } } }), 'INVALID_PAYLOAD'],
    [body({ data: { ...data, unknown: true } }), 'INVALID_PAYLOAD'],
    [body({ data: { ...data, idempotencyKey: 'internal:x' } }), 'INVALID_PAYLOAD'],
  ])('rejects %s as %s', (raw, reason) => {
    expect(reasonOf(raw)[0]).toBe(reason);
  });
});

describe('classifyFailure', () => {
  test.each<[Error, FailureReason]>([
    [new InvalidMessageError('INVALID_JSON', []), 'INVALID_JSON'],
    [new WalletNotFoundError('x'), 'WALLET_NOT_FOUND'],
    [new IdempotencyKeyConflictError('x'), 'IDEMPOTENCY_KEY_CONFLICT'],
    [new ExternalTransactionIdConflictError('x'), 'EXTERNAL_TRANSACTION_ID_CONFLICT'],
    [new InboxMessageConflictError('x'), 'INBOX_MESSAGE_CONFLICT'],
    [new InvalidCommandError('x'), 'INVALID_PAYLOAD'],
  ])('%p is permanent', (error, reason) => {
    expect(classifyFailure(error)).toEqual({ kind: 'permanent', reason });
  });

  test('infrastructure failures are transient', () => {
    expect(classifyFailure(new TransientInfrastructureError('x')))
      .toEqual({ kind: 'transient', reason: 'SERVICE_UNAVAILABLE', unexpected: false });
  });

  test('an unknown error is transient and flagged as unexpected', () => {
    expect(classifyFailure(new TypeError('bug'))).toEqual({ kind: 'transient', reason: 'UNEXPECTED_ERROR', unexpected: true });
  });
});

describe('classifyFailure: o motivo da DLQ nunca deriva de texto de erro', () => {
  test('mensagem com valor monetário não aparece no motivo, seja qual for a classe do erro', () => {
    const leaky = 'balance 123.45 for wallet';
    const errors = [
      new Error(leaky),
      new WalletNotFoundError(leaky),
      new InvalidCommandError(leaky),
      new InvalidMessageError('INVALID_PAYLOAD', [leaky]),
      new TransientInfrastructureError(leaky),
      leaky,
      { message: leaky },
    ];
    for (const error of errors) {
      expect(JSON.stringify(classifyFailure(error))).not.toContain('123.45');
    }
  });
});
