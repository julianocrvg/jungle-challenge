import { describe, expect, test } from 'bun:test';
import {
  type ConsumerSettings,
  consumerSettingsFromEnv,
  pendingReferenceSettingsFromEnv,
  validateConsumerSettings,
  validatePendingReferenceSettings,
  validatePoolBudget,
} from '../../src/config';

const database = { poolMax: 20, lockTimeoutMs: 10_000 };
const settings = (override: Partial<ConsumerSettings> = {}): ConsumerSettings => ({ ...consumerSettingsFromEnv({}), ...override });

describe('consumer settings', () => {
  test('defaults are valid with the default pool and lock timeout', () => {
    expect(() => validateConsumerSettings(settings(), database)).not.toThrow();
    expect(settings()).toMatchObject({ maxAttempts: 5, waitTimeSeconds: 20, visibilityTimeoutSeconds: 30, concurrency: 10 });
  });

  test('visibility timeout must cover lock_timeout plus the processing margin', () => {
    expect(() => validateConsumerSettings(settings({ visibilityTimeoutSeconds: 14 }), database))
      .toThrow(/SQS_CONSUMER_VISIBILITY_TIMEOUT_S/);
    expect(() => validateConsumerSettings(settings({ visibilityTimeoutSeconds: 15 }), database)).not.toThrow();
    expect(() => validateConsumerSettings(settings({ visibilityTimeoutSeconds: 30 }), { ...database, lockTimeoutMs: 26_000 }))
      .toThrow(/DB_LOCK_TIMEOUT_MS/);
  });

  test('long polling is capped at 20 s and the backoff at 12 h', () => {
    expect(() => validateConsumerSettings(settings({ waitTimeSeconds: 21 }), database)).toThrow(/WAIT_SECONDS/);
    expect(() => validateConsumerSettings(settings({ backoffMaxMs: 13 * 3_600_000 }), database)).toThrow(/BACKOFF/);
    expect(() => validateConsumerSettings(settings({ backoffBaseMs: 2_000, backoffMaxMs: 1_000 }), database)).toThrow(/BACKOFF/);
  });

  test('reads the queue URLs from the environment', () => {
    const fromEnv = consumerSettingsFromEnv({ SQS_ENDPOINT: 'http://sqs:4566', SQS_CONSUMER_ENABLED: 'false' });
    expect(fromEnv.enabled).toBe(false);
    expect(fromEnv.queueUrl).toBe('http://sqs:4566/000000000000/wager-transactions.fifo');
    expect(fromEnv.deadLetterQueueUrl).toBe('http://sqs:4566/000000000000/wager-transactions-dlq.fifo');
  });
});

describe('pending reference worker settings', () => {
  test('defaults: enabled, TTL of 1 h, 30 attempts, backoff 1 s to 5 min, 4 resolves in parallel', () => {
    expect(pendingReferenceSettingsFromEnv({})).toEqual({
      enabled: true, pollIntervalMs: 1_000, batchSize: 50, concurrency: 4,
      ttlMs: 3_600_000, maxAttempts: 30, backoffBaseMs: 1_000, backoffMaxMs: 300_000,
    });
  });

  test('reads the environment and refuses a backoff base above its ceiling', () => {
    const fromEnv = pendingReferenceSettingsFromEnv({
      PENDING_REFERENCE_WORKER_ENABLED: 'false', PENDING_REFERENCE_TTL_MS: '600000', PENDING_REFERENCE_MAX_ATTEMPTS: '7',
    });
    expect(fromEnv).toMatchObject({ enabled: false, ttlMs: 600_000, maxAttempts: 7 });
    expect(() => pendingReferenceSettingsFromEnv({ PENDING_REFERENCE_CONCURRENCY: '0' })).toThrow(/PENDING_REFERENCE_CONCURRENCY/);
    expect(() => validatePendingReferenceSettings({ ...fromEnv, backoffBaseMs: 2_000, backoffMaxMs: 1_000 })).toThrow(/BACKOFF/);
  });
});

describe('pool budget', () => {
  const workers = { consumerConcurrency: 10, outboxPublishers: 1, pendingReferenceConcurrency: 4 };

  test('defaults use exactly DB_POOL_MAX - 5: 10 + 1 + 4 = 15', () => {
    expect(() => validatePoolBudget(database, workers)).not.toThrow();
  });

  test('the workers together never take the 5 connections reserved for HTTP', () => {
    expect(() => validatePoolBudget(database, { ...workers, pendingReferenceConcurrency: 5 })).toThrow(/DB_POOL_MAX/);
    expect(() => validatePoolBudget(database, { ...workers, consumerConcurrency: 11 })).toThrow(/reserved for HTTP/);
    expect(() => validatePoolBudget(database, { ...workers, outboxPublishers: 0, pendingReferenceConcurrency: 5 })).not.toThrow();
    expect(() => validatePoolBudget({ poolMax: 5 }, { consumerConcurrency: 0, outboxPublishers: 1, pendingReferenceConcurrency: 0 }))
      .toThrow(/DB_POOL_MAX/);
    expect(() => validatePoolBudget({ poolMax: 30 }, { ...workers, consumerConcurrency: 20 })).not.toThrow();
  });
});
