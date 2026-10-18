import { describe, expect, test } from 'bun:test';
import { type ConsumerSettings, consumerSettingsFromEnv, validateConsumerSettings } from '../../src/config';

const database = { poolMax: 20, lockTimeoutMs: 10_000 };
const settings = (override: Partial<ConsumerSettings> = {}): ConsumerSettings => ({ ...consumerSettingsFromEnv({}), ...override });

describe('consumer settings', () => {
  test('defaults are valid with the default pool and lock timeout', () => {
    expect(() => validateConsumerSettings(settings(), database, true)).not.toThrow();
    expect(settings()).toMatchObject({ maxAttempts: 5, waitTimeSeconds: 20, visibilityTimeoutSeconds: 30, concurrency: 10 });
  });

  test('visibility timeout must cover lock_timeout plus the processing margin', () => {
    expect(() => validateConsumerSettings(settings({ visibilityTimeoutSeconds: 14 }), database, true))
      .toThrow(/SQS_CONSUMER_VISIBILITY_TIMEOUT_S/);
    expect(() => validateConsumerSettings(settings({ visibilityTimeoutSeconds: 15 }), database, true)).not.toThrow();
    expect(() => validateConsumerSettings(settings({ visibilityTimeoutSeconds: 30 }), { ...database, lockTimeoutMs: 26_000 }, true))
      .toThrow(/DB_LOCK_TIMEOUT_MS/);
  });

  test('concurrency plus the outbox publisher must stay below the pool', () => {
    expect(() => validateConsumerSettings(settings({ concurrency: 19 }), database, true)).toThrow(/DB_POOL_MAX/);
    expect(() => validateConsumerSettings(settings({ concurrency: 19 }), database, false)).not.toThrow();
    expect(() => validateConsumerSettings(settings({ concurrency: 20 }), database, false)).toThrow(/DB_POOL_MAX/);
    expect(() => validateConsumerSettings(settings({ concurrency: 18 }), database, true)).not.toThrow();
  });

  test('long polling is capped at 20 s and the backoff at 12 h', () => {
    expect(() => validateConsumerSettings(settings({ waitTimeSeconds: 21 }), database, true)).toThrow(/WAIT_SECONDS/);
    expect(() => validateConsumerSettings(settings({ backoffMaxMs: 13 * 3_600_000 }), database, true)).toThrow(/BACKOFF/);
    expect(() => validateConsumerSettings(settings({ backoffBaseMs: 2_000, backoffMaxMs: 1_000 }), database, true)).toThrow(/BACKOFF/);
  });

  test('reads the queue URLs from the environment', () => {
    const fromEnv = consumerSettingsFromEnv({ SQS_ENDPOINT: 'http://sqs:4566', SQS_CONSUMER_ENABLED: 'false' });
    expect(fromEnv.enabled).toBe(false);
    expect(fromEnv.queueUrl).toBe('http://sqs:4566/000000000000/wager-transactions.fifo');
    expect(fromEnv.deadLetterQueueUrl).toBe('http://sqs:4566/000000000000/wager-transactions-dlq.fifo');
  });
});
