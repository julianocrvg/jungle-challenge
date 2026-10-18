import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher, PublishResult } from '../../src/application/ports/event-publisher';
import { defaultIdleInTransactionTimeoutMs } from '../../src/config';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { parseTimestamp } from '../../src/infrastructure/persistence/timestamps';
import { createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload } from './support/app';
import { createTestOrm, type Sql, sqlRunner, TEST_DATABASE_URL, walletsDivergingFromLedger } from './support/database';
import {
  countById,
  createTempFifoQueue,
  DelayedPublisher,
  deleteQueue,
  drain,
  ManualClock,
  outboxIds,
  outboxPublisher,
  pendingOutbox,
  receiveAll,
  SQS,
  sqsPublisher,
  waitFor,
} from './support/outbox';

/*
 * Publisher da outbox contra Postgres e LocalStack reais (ARCHITECTURE 6). Cada teste usa uma fila FIFO própria
 * e termina conferindo: nenhum evento pendente, cada eventId exatamente uma vez na fila e saldo == ledger.
 */

let orm: MikroORM;
let sql: Sql;
let api: TestApp;
let sqs: SQSClient;
const queues: string[] = [];
const extraOrms: MikroORM[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  api = await startTestApp(); // publisher desligado: os eventos ficam pendentes até o teste publicar
  sqs = createSqsClient(SQS);
});

afterEach(async () => {
  while (extraOrms.length > 0) await extraOrms.pop()?.close(true);
});

afterAll(async () => {
  await api?.close();
  for (const queueUrl of queues) await deleteQueue(sqs, queueUrl);
  sqs?.destroy();
  await orm?.close(true);
});

async function newQueue(): Promise<string> {
  const queueUrl = await createTempFifoQueue(sqs, 'outbox-publisher');
  queues.push(queueUrl);
  return queueUrl;
}

/** Outro "processo": ORM e pool próprios. */
async function newOrm(): Promise<MikroORM> {
  const instance = await MikroORM.init(createOrmConfig(TEST_DATABASE_URL));
  extraOrms.push(instance);
  return instance;
}

/** Eventos reais: wallets com saldo inicial (WalletBalanceChanged) e apostas (Processed + BalanceChanged). */
async function seedEvents(target: TestApp, wallets: number, betsPerWallet: number): Promise<Set<string>> {
  const before = await outboxIds(sql);
  for (let w = 0; w < wallets; w++) {
    const wallet = await createWalletViaApi(target, '100.00');
    for (let b = 0; b < betsPerWallet; b++) {
      const result = await submit(target, wagerPayload(wallet, { money: { amount: '1.00', currency: 'BRL' } }));
      expect(result.status).toBe(200);
    }
  }
  const created = new Set([...await outboxIds(sql)].filter((id) => !before.has(id)));
  expect(created.size).toBe(wallets * (1 + 2 * betsPerWallet));
  return created;
}

/** Fechamento comum: nada pendente, a fila tem exatamente os eventos esperados (uma vez cada) e saldo == ledger. */
async function expectFullyPublished(queueUrl: string, expected: Set<string>): Promise<void> {
  expect(await pendingOutbox(sql)).toEqual([]);
  const received = await receiveAll(sqs, queueUrl, expected.size);
  const counts = countById(received);
  expect([...counts.values()].every((count) => count === 1)).toBe(true);
  expect(new Set(counts.keys())).toEqual(expected);
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
}

function closedPort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

describe('outbox INSERT', () => {
  test('next_attempt_at comes from the application Clock, never from the column default', async () => {
    const fixed = new Date('2020-01-01T00:00:00.000Z');
    const clockApp = await startTestApp({ clock: new ManualClock(fixed) });
    let created: Set<string>;
    try {
      created = await seedEvents(clockApp, 1, 0);
    } finally {
      await clockApp.close();
    }
    const rows = await sql(`SELECT occurred_at, next_attempt_at FROM outbox WHERE id IN (?)`, [[...created]]);
    expect(rows.length).toBe(1);
    expect(parseTimestamp(rows[0]?.occurred_at).getTime()).toBe(fixed.getTime());
    expect(parseTimestamp(rows[0]?.next_attempt_at).getTime()).toBe(fixed.getTime());

    const queueUrl = await newQueue();
    await drain(outboxPublisher({ orm, publisher: sqsPublisher(queueUrl) }).batch);
    await expectFullyPublished(queueUrl, created);
  });
});

describe('PublishOutboxBatch against LocalStack', () => {
  test('publishes every event with eventId as dedup id and walletId as group id, and marks published_at', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(api, 2, 3);
    const { batch, metrics } = outboxPublisher({ orm, publisher: sqsPublisher(queueUrl) });

    expect(await drain(batch)).toBe(created.size);
    expect(metrics.gaugeValue('outbox_lag_seconds')).toBe(0);

    const rows = await sql(`SELECT id, aggregate_id, event_type, published_at FROM outbox WHERE id IN (?)`, [[...created]]);
    expect(rows.every((row) => row.published_at !== null)).toBe(true);

    expect(await pendingOutbox(sql)).toEqual([]);
    const received = await receiveAll(sqs, queueUrl, created.size);
    for (const event of received) {
      const row = rows.find((r) => r.id === event.eventId);
      expect(event.deduplicationId).toBe(event.eventId);
      expect(event.groupId).toBe(row?.aggregate_id as string);
      expect(event.eventType).toBe(row?.event_type as string);
      expect(event.body.aggregateId).toBe(row?.aggregate_id as string);
    }
    expect(new Set(received.map((e) => e.eventId))).toEqual(created);
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });

  test('SQS unavailable: schedules a deterministic retry without losing the event, then publishes', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(api, 1, 1); // 3 eventos
    const clock = new ManualClock(new Date());
    const down = `http://127.0.0.1:${closedPort()}`;
    const unavailable = outboxPublisher({
      orm, clock, publisher: sqsPublisher(`${down}/000000000000/x.fifo`, { endpoint: down }),
    });

    expect(await unavailable.batch.execute()).toEqual({ claimed: 3, published: 0, retried: 3 });
    expect(unavailable.metrics.counter('outbox_publish_call_failures_total', { reason: 'call_error' })).toBe(1);
    const pending = await pendingOutbox(sql);
    expect(pending.length).toBe(3);
    for (const row of pending) {
      expect(row.attempts).toBe(1);
      expect(parseTimestamp(row.next_attempt_at).getTime()).toBe(clock.current.getTime() + 1_000);
    }

    const available = outboxPublisher({ orm, clock, publisher: sqsPublisher(queueUrl) });
    clock.advance(999);
    expect((await available.batch.execute()).claimed).toBe(0); // backoff ainda não venceu
    clock.advance(1);
    expect(await available.batch.execute()).toEqual({ claimed: 3, published: 3, retried: 0 });
    await expectFullyPublished(queueUrl, created);
  });

  test('send timeout: a broker that never answers is cut at the timeout, the connection is released and the batch is retried', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(api, 1, 0);
    const hanging = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); // aceita e nunca responde
    const clock = new ManualClock(new Date());
    const ownOrm = await newOrm();
    try {
      const endpoint = `http://127.0.0.1:${hanging.port}`;
      const stuck = outboxPublisher({
        orm: ownOrm, clock, sendTimeoutMs: 300,
        publisher: sqsPublisher(`${endpoint}/000000000000/x.fifo`, { endpoint }),
      });
      const started = Date.now();
      expect(await stuck.batch.execute()).toEqual({ claimed: 1, published: 0, retried: 1 });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(stuck.metrics.counter('outbox_publish_call_failures_total', { reason: 'timeout' })).toBe(1);
    } finally {
      hanging.stop(true);
    }

    // Nenhuma sessão ficou presa numa transação aberta, e o mesmo pool continua servindo.
    const idle = await sql(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
    expect(idle[0]?.n).toBe(0);
    clock.advance(1_000);
    expect((await outboxPublisher({ orm: ownOrm, clock, publisher: sqsPublisher(queueUrl) }).batch.execute()).published).toBe(1);
    await expectFullyPublished(queueUrl, created);
  });
});

describe('idle_in_transaction_session_timeout', () => {
  test('a slow send within the send timeout does not kill the session (idle timeout = 3x send timeout)', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(api, 1, 0);
    const sendTimeoutMs = 500;
    const { batch } = outboxPublisher({
      orm: await newOrm(),
      sendTimeoutMs,
      // A razão de 3x da configuração, sem o piso de 15 s, para o teste ficar perto do limite.
      idleInTransactionTimeoutMs: 3 * sendTimeoutMs,
      publisher: new DelayedPublisher(sqsPublisher(queueUrl), 450), // logo abaixo do timeout de envio
    });
    expect(await batch.execute()).toEqual({ claimed: 1, published: 1, retried: 0 });
    expect(defaultIdleInTransactionTimeoutMs(sendTimeoutMs)).toBeGreaterThanOrEqual(3 * sendTimeoutMs);
    await expectFullyPublished(queueUrl, created);
  });

  test('control: an idle timeout shorter than the send kills the session, nothing is marked, and the resend is deduplicated', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(api, 1, 0);
    const { batch } = outboxPublisher({
      orm: await newOrm(),
      sendTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 200, // configuração que a aplicação recusa: só para provar que o guarda age
      publisher: new DelayedPublisher(sqsPublisher(queueUrl), 1_000),
    });
    await expect(batch.execute()).rejects.toThrow();
    // O envio aconteceu, mas a transação morreu antes do commit: o evento continua pendente.
    expect((await pendingOutbox(sql)).map((row) => row.id)).toEqual([...created]);

    await drain(outboxPublisher({ orm, publisher: sqsPublisher(queueUrl) }).batch);
    await expectFullyPublished(queueUrl, created); // reenvio deduplicado pelo eventId: uma mensagem só
  });
});

describe('worker lifecycle', () => {
  test('recovery after restart: events committed while no publisher ran (or left in retry) are published by the next instance', async () => {
    const queueUrl = await newQueue();
    // Instância 1: grava e "morre" sem publicar; antes disso, um lote falhou com o SQS fora do ar.
    const first = await startTestApp();
    let created: Set<string>;
    try {
      created = await seedEvents(first, 2, 2);
      const down = `http://127.0.0.1:${closedPort()}`;
      const failing = outboxPublisher({ orm, publisher: sqsPublisher(`${down}/000000000000/x.fifo`, { endpoint: down }) });
      expect((await failing.batch.execute()).retried).toBe(10);
    } finally {
      await first.close();
    }
    expect((await pendingOutbox(sql)).length).toBe(created.size);

    // Instância 2: sobe com o publisher ligado e drena tudo, inclusive os que estavam em backoff.
    const second = await startTestApp({ outbox: { enabled: true, pollIntervalMs: 50 }, sqs: { eventsQueueUrl: queueUrl } });
    try {
      await waitFor(() => pendingOutbox(sql), (rows) => rows.length === 0);
    } finally {
      await second.close();
    }
    await expectFullyPublished(queueUrl, created);
  });

  test('shutdown via app.close(): the in-flight batch is committed and no new batch starts (SIGTERM path, ARCHITECTURE 6.5)', async () => {
    const queueUrl = await newQueue();
    const gated = new GatedPublisher(sqsPublisher(queueUrl));
    const app = await startTestApp({ outbox: { enabled: true, pollIntervalMs: 50 }, eventPublisher: gated });
    let created: Set<string>;
    let closed = false;
    let closing: Promise<void> | undefined;
    try {
      created = await seedEvents(app, 1, 0);
      await gated.entered; // o worker está no meio do lote, com a transação aberta

      closing = app.close().then(() => { closed = true; });
      await Bun.sleep(0);
      expect(closed).toBe(false); // close espera o lote
      expect((await pendingOutbox(sql)).length).toBe(1);

      gated.release();
      await closing;
    } finally {
      gated.release();
      if (!closed) await (closing ?? app.close());
    }
    expect(gated.calls).toBe(1); // nenhum lote novo depois do stop
    await expectFullyPublished(queueUrl, created);
  });
});

/** Segura o primeiro envio até `release()`: deixa um lote "em andamento" de forma determinística. */
class GatedPublisher implements EventPublisher {
  calls = 0;
  readonly entered: Promise<void>;
  private signalEntered!: () => void;
  private readonly gate: Promise<void>;
  release!: () => void;

  constructor(private readonly inner: EventPublisher) {
    this.entered = new Promise((resolve) => { this.signalEntered = resolve; });
    this.gate = new Promise((resolve) => { this.release = resolve; });
  }

  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    this.calls += 1;
    this.signalEntered();
    await this.gate;
    return this.inner.publish(messages, signal);
  }
}
