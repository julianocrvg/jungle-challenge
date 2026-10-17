import { describe, expect, test } from 'bun:test';
import { backoffDelayMs, DEFAULT_BACKOFF } from '../../../src/domain/backoff';
import { InvalidMessageStateError } from '../../../src/domain/errors';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { NOW, nextId, walletWith, brl } from './support';

const at = (ms: number) => new Date(NOW.getTime() + ms);

describe('InboxMessage', () => {
  const receive = () =>
    InboxMessage.receive({ messageId: 'm1', consumerName: 'wager-consumer', payloadHash: 'h'.repeat(64), receivedAt: NOW });

  test('is received unprocessed and becomes processed once', () => {
    const message = receive();
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    message.markProcessed(at(10));
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at(10));
  });

  test('cannot be processed twice', () => {
    const message = receive();
    message.markProcessed(NOW);
    expect(() => message.markProcessed(at(10))).toThrow(InvalidMessageStateError);
  });

  test('rehydrate keeps the persisted processedAt', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'm', consumerName: 'c', payloadHash: 'h', receivedAt: NOW, processedAt: at(5),
    });
    expect(message.isProcessed()).toBe(true);
  });
});

describe('backoff', () => {
  const policy = { baseMs: 1_000, maxMs: 60_000 };

  test('doubles per attempt and is capped', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });

  test('does not overflow for absurd attempt counts', () => {
    expect(backoffDelayMs(10_000, policy)).toBe(60_000);
  });

  test('default policy starts at 1s and caps at 5 minutes', () => {
    expect(backoffDelayMs(1)).toBe(DEFAULT_BACKOFF.baseMs);
    expect(backoffDelayMs(50)).toBe(5 * 60_000);
  });
});

describe('OutboxMessage', () => {
  const enqueue = () => {
    const wallet = walletWith('0.00');
    const entry = wallet.credit({ money: brl('10.00'), transactionId: 'tx-1', entryId: nextId(), at: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, { eventId: 'event-1', correlationId: 'corr-1', occurredAt: NOW });
    return { event, message: OutboxMessage.enqueue(event) };
  };

  test('enqueue copies the envelope: id is the eventId, payload is the serialized event', () => {
    const { event, message } = enqueue();
    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe(event.aggregateId);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(event.toJSON());
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
  });

  test('is due immediately, and not before nextAttemptAt', () => {
    const { message } = enqueue();
    expect(message.isDue(NOW)).toBe(true);
    expect(message.isDue(at(-1))).toBe(false);
  });

  test('scheduleRetry counts the attempt and pushes nextAttemptAt out with exponential backoff', () => {
    const { message } = enqueue();
    const policy = { baseMs: 1_000, maxMs: 60_000 };

    message.scheduleRetry(NOW, policy);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(at(1_000));
    expect(message.isDue(at(999))).toBe(false);
    expect(message.isDue(at(1_000))).toBe(true);

    message.scheduleRetry(at(1_000), policy);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(at(1_000 + 2_000));
  });

  test('markPublished makes it non-pending and never due again', () => {
    const { message } = enqueue();
    message.markPublished(at(50));
    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(at(50));
    expect(message.isDue(at(10_000))).toBe(false);
  });

  test('a published message can be neither published nor retried again', () => {
    const { message } = enqueue();
    message.markPublished(at(50));
    expect(() => message.markPublished(at(60))).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(at(60))).toThrow(InvalidMessageStateError);
  });

  test('rehydrate restores attempts and schedule', () => {
    const { message } = enqueue();
    const copy = OutboxMessage.rehydrate({
      id: message.id, aggregateId: message.aggregateId, eventType: message.eventType, payload: message.payload,
      occurredAt: NOW, attempts: 4, nextAttemptAt: at(9_000),
    });
    expect(copy.attempts).toBe(4);
    expect(copy.isDue(at(8_999))).toBe(false);
    expect(copy.isDue(at(9_000))).toBe(true);
  });
});
