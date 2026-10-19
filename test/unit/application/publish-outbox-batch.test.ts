import { describe, expect, test } from 'bun:test';
import { PublishOutboxBatch } from '../../../src/application/outbox/publish-outbox-batch';
import type { EventPublisher, PublishResult } from '../../../src/application/ports/event-publisher';
import type { LogFields, StructuredLogger } from '../../../src/application/ports/structured-logger';
import type {
  OutboxRepository,
  TransactionalRepositories,
  TransactionOptions,
  UnitOfWork,
} from '../../../src/application/ports/unit-of-work';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { describeError } from '../../../src/infrastructure/logging/describe-error';
import { InMemoryMetrics } from '../../../src/infrastructure/metrics/in-memory-metrics';
import { OutboxPublisherWorker } from '../../../src/interface/workers/outbox-publisher.worker';

/*
 * Decisões do tick com fakes das portas. Claim com SKIP LOCKED, atomicidade e SQS real ficam nos testes de
 * integração (test/integration/outbox-*.test.ts).
 */

const T0 = new Date('2026-10-17T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const BACKOFF = { baseMs: 1_000, maxMs: 60_000 };

class FakeClock {
  constructor(public current: Date) {}
  now(): Date {
    return this.current;
  }
}

class FakeOutbox implements Pick<OutboxRepository, 'claimDue' | 'markPublished' | 'saveRetry'> {
  readonly rows = new Map<string, OutboxMessage>();
  readonly claimedAt: Date[] = [];

  add(id: string, occurredAt = T0): void {
    this.rows.set(id, OutboxMessage.rehydrate({
      id, aggregateId: `wallet-${id}`, eventType: 'WalletBalanceChanged', payload: { eventId: id },
      occurredAt, attempts: 0, nextAttemptAt: occurredAt,
    }));
  }

  failClaim: Error | undefined;

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    if (this.failClaim !== undefined) throw this.failClaim;
    this.claimedAt.push(now);
    return [...this.rows.values()].filter((m) => m.isDue(now)).slice(0, limit);
  }

  async markPublished(): Promise<void> {}
  async saveRetry(): Promise<void> {}
}

class FakeUnitOfWork implements UnitOfWork {
  readonly options: (TransactionOptions | undefined)[] = [];
  constructor(private readonly outbox: FakeOutbox) {}

  /** Simula a transação morrendo depois do trabalho (o commit falha). */
  failAfterWork: Error | undefined;

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>, options?: TransactionOptions): Promise<T> {
    this.options.push(options);
    const result = await work({ outbox: this.outbox } as unknown as TransactionalRepositories);
    if (this.failAfterWork !== undefined) throw this.failAfterWork;
    return result;
  }
}

class CapturingStructuredLogger implements StructuredLogger {
  readonly entries: { level: string; message: string; fields: LogFields }[] = [];
  info(message: string, fields: LogFields = {}): void { this.entries.push({ level: 'info', message, fields }); }
  warn(message: string, fields: LogFields = {}): void { this.entries.push({ level: 'warn', message, fields }); }
  error(message: string, fields: LogFields = {}): void { this.entries.push({ level: 'error', message, fields }); }
}

function setup(publish: EventPublisher['publish'], sendTimeoutMs = 1_000) {
  const outbox = new FakeOutbox();
  const uow = new FakeUnitOfWork(outbox);
  const clock = new FakeClock(at(500));
  const metrics = new InMemoryMetrics();
  const logger = new CapturingStructuredLogger();
  const useCase = new PublishOutboxBatch(uow, { publish }, clock, metrics, logger, {
    batchSize: 10, sendTimeoutMs, idleInTransactionTimeoutMs: 15_000, backoff: BACKOFF,
  });
  return { outbox, uow, clock, metrics, logger, useCase };
}

const allPublished = async (messages: readonly OutboxMessage[]): Promise<PublishResult> =>
  ({ published: messages.map((m) => m.id), failed: [] });

describe('PublishOutboxBatch', () => {
  test('marks accepted messages as published at the clock time, inside one transaction with the idle timeout', async () => {
    const { outbox, uow, metrics, useCase } = setup(allPublished);
    outbox.add('e1');
    outbox.add('e2');

    expect(await useCase.execute()).toEqual({ claimed: 2, published: 2, retried: 0 });
    expect(outbox.rows.get('e1')?.publishedAt).toEqual(at(500));
    expect(outbox.rows.get('e2')?.publishedAt).toEqual(at(500));
    expect(uow.options).toEqual([{ idleInTransactionTimeoutMs: 15_000 }]);
    expect(metrics.counter('outbox_published_total')).toBe(2);
    // O lag não é mais medido no tick: é calculado no scrape do /metrics (ARCHITECTURE 11.4).
    expect(metrics.gaugeValue('outbox_lag_seconds')).toBeUndefined();
  });

  test('claims with the application clock, not the database clock', async () => {
    const { outbox, useCase } = setup(allPublished);
    await useCase.execute();
    expect(outbox.claimedAt).toEqual([at(500)]);
  });

  test('partial failure: publishes the accepted entry and schedules a deterministic retry for the failed one', async () => {
    const { outbox, metrics, logger, useCase } = setup(async () => ({
      published: ['e1'],
      failed: [{ id: 'e2', fault: 'service', code: 'InternalError', message: 'boom' }],
    }));
    outbox.add('e1');
    outbox.add('e2', at(-4_500));

    expect(await useCase.execute()).toEqual({ claimed: 2, published: 1, retried: 1 });
    const failed = outbox.rows.get('e2');
    expect(failed?.isPending()).toBe(true);
    expect(failed?.attempts).toBe(1);
    expect(failed?.nextAttemptAt).toEqual(at(1_500)); // now + baseMs * 2^0
    expect(metrics.counter('outbox_retries_total', { fault: 'service' })).toBe(1);
    expect(metrics.counter('outbox_sender_faults_total', { code: 'InternalError' })).toBe(0);
    expect(logger.entries.map((e) => e.level)).toEqual(['warn']);
  });

  test('transaction fails after the send: no published/retry counter, commit failure counted, original error rethrown', async () => {
    const { outbox, uow, metrics, useCase } = setup(async () => ({
      published: ['e1'],
      failed: [{ id: 'e2', fault: 'service', code: 'InternalError', message: 'boom' }],
    }));
    outbox.add('e1');
    outbox.add('e2');
    const original = new Error('connection terminated');
    uow.failAfterWork = original;

    await expect(useCase.execute()).rejects.toBe(original); // a mesma instância, sem embrulho
    expect(metrics.counter('outbox_published_total')).toBe(0);
    expect(metrics.counter('outbox_retries_total', { fault: 'service' })).toBe(0);
    expect(metrics.counter('outbox_commit_failures_total')).toBe(1);
  });

  test('transaction fails before the send (claim): not a commit failure', async () => {
    const { outbox, uow, metrics, useCase } = setup(allPublished);
    outbox.add('e1');
    const original = new Error('db down');
    outbox.failClaim = original;

    await expect(useCase.execute()).rejects.toBe(original);
    expect(uow.options).toHaveLength(1);
    expect(metrics.counter('outbox_commit_failures_total')).toBe(0);
  });

  test('sender fault: retried as well, but logged as error with its own counter', async () => {
    const { outbox, metrics, logger, useCase } = setup(async () => ({
      published: [],
      failed: [{ id: 'e1', fault: 'sender', code: 'InvalidParameterValue', message: 'bad' }],
    }));
    outbox.add('e1');

    await useCase.execute();
    expect(outbox.rows.get('e1')?.attempts).toBe(1);
    expect(metrics.counter('outbox_sender_faults_total', { code: 'InvalidParameterValue' })).toBe(1);
    expect(metrics.counter('outbox_retries_total', { fault: 'sender' })).toBe(1);
    expect(logger.entries[0]).toMatchObject({ level: 'error', fields: { eventId: 'e1', walletId: 'wallet-e1', code: 'InvalidParameterValue' } });
  });

  test('call error (broker unreachable): every message of the batch is retried, none is lost', async () => {
    const { outbox, metrics, useCase } = setup(async () => {
      throw new Error('ECONNREFUSED');
    });
    outbox.add('e1');
    outbox.add('e2');

    expect(await useCase.execute()).toEqual({ claimed: 2, published: 0, retried: 2 });
    expect([...outbox.rows.values()].every((m) => m.isPending() && m.attempts === 1)).toBe(true);
    expect(metrics.counter('outbox_publish_call_failures_total', { reason: 'call_error' })).toBe(1);
  });

  test('timeout: aborts the call and retries the whole batch (ambiguous outcome)', async () => {
    let aborted = false;
    const { outbox, metrics, useCase } = setup((_messages, signal) => new Promise<PublishResult>((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ published: [], failed: [] });
      });
    }), 20);
    outbox.add('e1');

    expect(await useCase.execute()).toEqual({ claimed: 1, published: 0, retried: 1 });
    expect(aborted).toBe(true);
    expect(metrics.counter('outbox_publish_call_failures_total', { reason: 'timeout' })).toBe(1);
  });

  test('an entry the broker did not mention is retried, never assumed published', async () => {
    const { outbox, useCase } = setup(async () => ({ published: [], failed: [] }));
    outbox.add('e1');
    await useCase.execute();
    expect(outbox.rows.get('e1')?.isPending()).toBe(true);
    expect(outbox.rows.get('e1')?.attempts).toBe(1);
  });

  test('backoff keeps a message out of the next claim until it is due', async () => {
    let fail = true;
    const { outbox, clock, useCase } = setup(async (messages) =>
      (fail ? { published: [], failed: [] } : allPublished(messages)));
    outbox.add('e1');

    await useCase.execute(); // falha em t=500, próximo em t=1500
    fail = false;
    clock.current = at(1_499);
    expect((await useCase.execute()).claimed).toBe(0);
    clock.current = at(1_500);
    expect(await useCase.execute()).toEqual({ claimed: 1, published: 1, retried: 0 });
  });
});

describe('OutboxPublisherWorker', () => {
  test('stop() waits for the in-flight batch and does not start another one', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const batch = {
      execute: async () => {
        calls += 1;
        started();
        await gate;
        return { claimed: 10, published: 10, retried: 0 }; // lote cheio: sem stop, rodaria de novo na hora
      },
    };
    const worker = new OutboxPublisherWorker(batch as unknown as PublishOutboxBatch, new InMemoryMetrics(),
      new CapturingStructuredLogger(), { enabled: true, batchSize: 10, pollIntervalMs: 60_000 });

    worker.start();
    await inFlight;
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(calls).toBe(1);
  });

  test('stop() wakes an idle worker immediately instead of waiting for the poll interval', async () => {
    const batch = { execute: async () => ({ claimed: 0, published: 0, retried: 0 }) };
    const worker = new OutboxPublisherWorker(batch as unknown as PublishOutboxBatch, new InMemoryMetrics(),
      new CapturingStructuredLogger(), { enabled: true, batchSize: 10, pollIntervalMs: 60_000 });
    worker.start();
    await Promise.resolve();
    await worker.stop(); // terminaria só depois de 60 s se o sono não fosse interrompível
  });

  test('a failing tick is logged and counted, and the loop keeps running', async () => {
    let calls = 0;
    const metrics = new InMemoryMetrics();
    let secondCall!: () => void;
    const reachedSecond = new Promise<void>((resolve) => { secondCall = resolve; });
    const batch = {
      execute: async () => {
        calls += 1;
        if (calls === 1) throw new Error('db down');
        secondCall();
        return { claimed: 0, published: 0, retried: 0 };
      },
    };
    const worker = new OutboxPublisherWorker(batch as unknown as PublishOutboxBatch, metrics,
      new CapturingStructuredLogger(), { enabled: true, batchSize: 10, pollIntervalMs: 1 });
    worker.start();
    await reachedSecond;
    await worker.stop();
    expect(metrics.counter('outbox_tick_errors_total')).toBe(1);
  });
});

describe('nome do erro no log do publisher', () => {
  // A aplicação (PublishOutboxBatch) e a infraestrutura (describeError) usam a mesma regra (SAFE_ERROR_NAME):
  // para qualquer nome, ou os dois deixam o nome passar ou os dois o descartam.
  test.each([
    'TimeoutError', 'QueueDoesNotExist', '$Dollar', 'A'.repeat(64), 'A'.repeat(65), 'bad name 123.45', '',
    '1leading', 'Line\nBreak', 'Ünicode', 'with-dash', 'x'.repeat(10) + '.' + 'y',
  ])('o mesmo conjunto aceito para %p', async (name) => {
    const error = new Error('x');
    error.name = name;
    const { outbox, logger, useCase } = setup(async () => { throw error; });
    outbox.add('e1');
    await useCase.execute();

    const logged = logger.entries.find((e) => e.message.includes('publish failed'))?.fields.errorName;
    const described = describeError(error).errorName;
    const publisherKeptIt = logged === name;
    const describeKeptIt = described === name;
    expect(publisherKeptIt).toBe(describeKeptIt);
    expect(logged === name || logged === 'unknown').toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain('123.45');
  });
});
