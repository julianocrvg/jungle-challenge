import { describe, expect, test } from 'bun:test';
import {
  defaultIdleInTransactionTimeoutMs,
  outboxSettingsFromEnv,
} from '../../../src/config';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { fromBatchOutput, toBatchEntries } from '../../../src/infrastructure/messaging/sqs-event-publisher';

const T0 = new Date('2026-10-17T12:00:00.000Z');

describe('SQS batch mapping', () => {
  const message = OutboxMessage.rehydrate({
    id: '0199f0a0-0000-7000-8000-000000000001',
    aggregateId: '0199f0a0-0000-7000-8000-0000000000aa',
    eventType: 'WalletBalanceChanged',
    payload: { eventId: '0199f0a0-0000-7000-8000-000000000001', data: { amount: '10.00' } },
    occurredAt: T0, attempts: 0, nextAttemptAt: T0,
  });

  test('eventId is the entry id and the deduplication id; aggregateId (walletId) is the group id', () => {
    expect(toBatchEntries([message])).toEqual([{
      Id: message.id,
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: message.aggregateId,
      MessageDeduplicationId: message.id,
      MessageAttributes: { eventType: { DataType: 'String', StringValue: 'WalletBalanceChanged' } },
    }]);
  });

  test('SenderFault separates sender errors from service errors', () => {
    expect(fromBatchOutput({
      Successful: [{ Id: 'a', MessageId: 'm', MD5OfMessageBody: 'x' }],
      Failed: [
        { Id: 'b', SenderFault: true, Code: 'InvalidParameterValue', Message: 'bad' },
        { Id: 'c', SenderFault: false, Code: 'InternalError', Message: 'boom' },
      ],
    })).toEqual({
      published: ['a'],
      failed: [
        { id: 'b', fault: 'sender', code: 'InvalidParameterValue', message: 'bad' },
        { id: 'c', fault: 'service', code: 'InternalError', message: 'boom' },
      ],
    });
  });
});

describe('outbox settings', () => {
  test('idle-in-transaction timeout defaults to 3x the send timeout, never below 15 s', () => {
    expect(defaultIdleInTransactionTimeoutMs(1_000)).toBe(15_000);
    expect(defaultIdleInTransactionTimeoutMs(10_000)).toBe(30_000);
    expect(outboxSettingsFromEnv({}).idleInTransactionTimeoutMs).toBe(15_000);
  });

  test('rejects an idle timeout that a slow but valid send could hit', () => {
    expect(() => outboxSettingsFromEnv({ OUTBOX_SEND_TIMEOUT_MS: '10000', OUTBOX_IDLE_TX_TIMEOUT_MS: '20000' }))
      .toThrow(/OUTBOX_IDLE_TX_TIMEOUT_MS/);
    expect(() => outboxSettingsFromEnv({ OUTBOX_IDLE_TX_TIMEOUT_MS: '14999' })).toThrow(/OUTBOX_IDLE_TX_TIMEOUT_MS/);
  });

  test('batch size is capped by the SendMessageBatch limit', () => {
    expect(() => outboxSettingsFromEnv({ OUTBOX_BATCH_SIZE: '11' })).toThrow(/at most 10/);
  });

  test('publisher is enabled unless explicitly disabled', () => {
    expect(outboxSettingsFromEnv({}).enabled).toBe(true);
    expect(outboxSettingsFromEnv({ OUTBOX_PUBLISHER_ENABLED: 'false' }).enabled).toBe(false);
  });
});
