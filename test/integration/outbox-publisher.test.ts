import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SendMessageBatchCommand, type SendMessageBatchCommandOutput, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher, PublishResult } from '../../src/application/ports/event-publisher';
import { defaultIdleInTransactionTimeoutMs } from '../../src/config';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { createSqsClient, SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import type { TransactionalRepositories, TransactionOptions, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { parseTimestamp } from '../../src/infrastructure/persistence/timestamps';
import { CapturingLogger, createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload } from './support/app';
import { assertCaptureWired, monetaryLeaks } from './support/logs';
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

/** Um logger compartilhado: o do Nest é estático, e o publisher de cada app loga no último criado. */
const logs = new CapturingLogger();
const startApp = (options: Parameters<typeof startTestApp>[0] = {}): Promise<TestApp> => startTestApp({ logger: logs, ...options });

beforeEach(() => logs.clear());

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  api = await startApp(); // publisher desligado: os eventos ficam pendentes até o teste publicar
  assertCaptureWired(logs);
  sqs = createSqsClient(SQS);
});

afterEach(async () => {
  while (extraOrms.length > 0) await extraOrms.pop()?.close(true);
  // Nenhum log do publisher nem do HTTP traz valor monetário (ARCHITECTURE 11.2).
  expect(monetaryLeaks(logs.entries)).toEqual([]);
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
    const clockApp = await startApp({ clock: new ManualClock(fixed) });
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
    expect(metrics.counter('outbox_published_total')).toBe(created.size);

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
    // O log do lote chegou ao logger capturado, só com o nome do erro de rede (nunca a mensagem) e sem valores.
    expect(unavailable.logger.entries.some((e) => e.message.includes('publish failed'))).toBe(true);
    expect(monetaryLeaks(unavailable.logger.entries)).toEqual([]);
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

/**
 * Cliente SQS que delega ao LocalStack real, mas tira do `SendMessageBatch` as entradas listadas e as devolve em
 * `Failed`, no formato da resposta real (`Id`, `SenderFault`, `Code`, `Message`). Assim o adaptador de verdade
 * (`fromBatchOutput`) faz o mapeamento, e as demais entradas chegam à fila.
 */
class PartialBatchClient {
  constructor(
    private readonly real: SQSClient,
    private readonly reject: Map<string, { senderFault: boolean; code: string }>,
  ) {}

  async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<SendMessageBatchCommandOutput> {
    if (!(command instanceof SendMessageBatchCommand)) throw new Error('PartialBatchClient only handles SendMessageBatch');
    const entries = command.input.Entries ?? [];
    const kept = entries.filter((entry) => !this.reject.has(entry.Id ?? ''));
    const output = kept.length === 0
      ? { Successful: [], Failed: [], $metadata: {} }
      : await this.real.send(new SendMessageBatchCommand({ ...command.input, Entries: kept }), options);
    const failed = entries.flatMap((entry) => {
      const rejection = this.reject.get(entry.Id ?? '');
      return rejection === undefined ? [] : [{ Id: entry.Id, SenderFault: rejection.senderFault, Code: rejection.code, Message: 'rejected by test' }];
    });
    return { ...output, Failed: [...(output.Failed ?? []), ...failed] };
  }
}

/**
 * Derruba, a partir de OUTRA conexão, a sessão do lote do publisher: a única com `RowShareLock` na outbox é a do
 * claim (`FOR UPDATE`; um INSERT pega `RowExclusiveLock`). Devolve os pids derrubados.
 */
async function terminateClaimSession(admin: Sql): Promise<number[]> {
  const rows = await admin(
    `SELECT l.pid, pg_terminate_backend(l.pid) AS ok
     FROM (SELECT DISTINCT l.pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
           WHERE c.relname = 'outbox' AND l.mode = 'RowShareLock' AND l.pid <> pg_backend_pid()) l`,
  );
  return rows.filter((row) => row.ok === true).map((row) => Number(row.pid));
}

/**
 * Delega ao publisher real (a mensagem chega ao LocalStack) e, depois do envio, derruba a sessão do lote. O use case
 * recebe o sucesso do broker e falha no primeiro comando seguinte (o UPDATE de published_at): nada é commitado.
 */
class KillSessionAfterSend implements EventPublisher {
  readonly terminated: number[] = [];
  constructor(private readonly inner: EventPublisher, private readonly admin: Sql) {}

  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    const result = await this.inner.publish(messages, signal);
    this.terminated.push(...await terminateClaimSession(this.admin));
    return result;
  }
}

/**
 * Decorator do UnitOfWork REAL: depois que o trabalho do lote terminou (envio e todos os UPDATEs), derruba a sessão
 * antes de devolver o controle ao `transactional`, de modo que a falha cai no próprio COMMIT. Pega um incremento
 * de métrica colocado no fim do callback, que a variante "depois do envio" não alcança.
 */
class KillSessionBeforeCommit implements UnitOfWork {
  constructor(private readonly real: UnitOfWork, private readonly admin: Sql, readonly terminated: number[]) {}

  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return this.real.run(async (repositories) => {
      const result = await work(repositories);
      this.terminated.push(...await terminateClaimSession(this.admin));
      return result;
    }, options);
  }
}

/** Falha (em vez de travar o teste) se a promessa não terminar no prazo: uma vaga de pool vazada travaria. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms}ms (pool slot leaked?)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe('partial publish against real Postgres and LocalStack', () => {
  test('SendMessageBatch with Failed entries (SenderFault true and false): only confirmed entries get published_at', async () => {
    const queueUrl = await newQueue();
    const created = [...await seedEvents(api, 1, 1)]; // 3 eventos: abertura, Processed e BalanceChanged da aposta
    const [acceptedId, senderId, serviceId] = created as [string, string, string];
    const clock = new ManualClock(new Date());
    const client = new PartialBatchClient(createSqsClient(SQS), new Map([
      [senderId, { senderFault: true, code: 'InvalidParameterValue' }],
      [serviceId, { senderFault: false, code: 'InternalError' }],
    ]));
    const { batch, metrics } = outboxPublisher({
      orm, clock, publisher: new SqsEventPublisher(client as unknown as SQSClient, queueUrl),
    });

    expect(await batch.execute()).toEqual({ claimed: 3, published: 1, retried: 2 });
    const rows = new Map((await sql(`SELECT id, attempts, next_attempt_at, published_at, occurred_at FROM outbox WHERE id IN (?)`, [created]))
      .map((row) => [row.id as string, row]));
    expect(rows.get(acceptedId)?.published_at).not.toBeNull();
    expect(rows.get(acceptedId)?.attempts).toBe(0);
    for (const id of [senderId, serviceId]) {
      expect(rows.get(id)?.published_at).toBeNull();
      expect(rows.get(id)?.attempts).toBe(1);
      expect(parseTimestamp(rows.get(id)?.next_attempt_at)).toEqual(new Date(clock.now().getTime() + 1_000));
    }
    expect(metrics.counter('outbox_published_total')).toBe(1);
    expect(metrics.counter('outbox_retries_total', { fault: 'sender' })).toBe(1);
    expect(metrics.counter('outbox_retries_total', { fault: 'service' })).toBe(1);
    expect(metrics.counter('outbox_sender_faults_total', { code: 'InvalidParameterValue' })).toBe(1);
    expect((await receiveAll(sqs, queueUrl, 1)).map((event) => event.eventId)).toEqual([acceptedId]);

    // O lag (calculado no scrape, ARCHITECTURE 11.4) inclui as linhas que esperam retry.
    const oldestFailed = Math.min(...[senderId, serviceId].map((id) => parseTimestamp(rows.get(id)?.occurred_at).getTime()));
    expect(await new MikroOrmUnitOfWork(orm, 10_000).run(({ outbox }) => outbox.oldestPendingOccurredAt())).toEqual(new Date(oldestFailed));

    clock.advance(1_000);
    expect(await drain(outboxPublisher({ orm, clock, publisher: sqsPublisher(queueUrl) }).batch)).toBe(2);
    expect(await pendingOutbox(sql)).toEqual([]);
    const rest = countById(await receiveAll(sqs, queueUrl, 2));
    expect(new Set(rest.keys())).toEqual(new Set([senderId, serviceId]));
    expect([...rest.values()].every((count) => count === 1)).toBe(true);
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });

  test('whole call rejected by the broker (exception, queue does not exist): every entry is retried, none is marked', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(api, 1, 0);
    const clock = new ManualClock(new Date());
    const missing = `${SQS.endpoint}/000000000000/does-not-exist-${Bun.randomUUIDv7()}.fifo`;
    const { batch, metrics } = outboxPublisher({ orm, clock, publisher: sqsPublisher(missing) });

    expect(await batch.execute()).toEqual({ claimed: 1, published: 0, retried: 1 });
    expect(metrics.counter('outbox_publish_call_failures_total', { reason: 'call_error' })).toBe(1);
    expect(metrics.counter('outbox_retries_total', { fault: 'call' })).toBe(1);
    expect(metrics.counter('outbox_published_total')).toBe(0);
    expect((await pendingOutbox(sql)).map((row) => [row.id, row.attempts])).toEqual([[[...created][0], 1]]);

    clock.advance(1_000);
    await drain(outboxPublisher({ orm, clock, publisher: sqsPublisher(queueUrl) }).batch);
    await expectFullyPublished(queueUrl, created);
  });
});

describe('commit failure after the send', () => {
  /**
   * Postgres e LocalStack reais; só a sessão do lote é derrubada (pg_terminate_backend de outra conexão). Pool de UMA
   * conexão: se a sessão morta vazasse a vaga (regressão do dc1bfb0), o reenvio no mesmo pool travaria.
   */
  async function expectCommitFailureRecovered(
    arrange: (publisher: EventPublisher) => { publisher: EventPublisher; wrapUow?: (real: UnitOfWork) => UnitOfWork; terminated: number[] },
  ): Promise<void> {
    const queueUrl = await newQueue();
    const created = await seedEvents(api, 1, 0);
    const [eventId] = [...created] as [string];
    const [before] = await sql(`SELECT next_attempt_at FROM outbox WHERE id = ?`, [eventId]);
    const clock = new ManualClock(new Date());
    const victimOrm = await MikroORM.init(createOrmConfig(TEST_DATABASE_URL, { poolMax: 1 }));
    try {
      const fault = arrange(sqsPublisher(queueUrl));
      const failing = outboxPublisher({ orm: victimOrm, clock, publisher: fault.publisher, wrapUow: fault.wrapUow });

      await expect(failing.batch.execute()).rejects.toThrow();
      expect(fault.terminated).toHaveLength(1);
      expect(failing.metrics.counter('outbox_published_total')).toBe(0);
      expect(failing.metrics.counter('outbox_retries_total', { fault: 'call' })).toBe(0);
      expect(failing.metrics.counter('outbox_commit_failures_total')).toBe(1);
      // A mensagem foi aceita pelo broker, mas nada foi marcado: attempts e next_attempt_at intactos.
      const [pending] = await pendingOutbox(sql);
      expect(pending?.id).toBe(eventId);
      expect(pending?.attempts).toBe(0);
      expect(parseTimestamp(pending?.next_attempt_at)).toEqual(parseTimestamp(before?.next_attempt_at));

      // Mesmo pool de uma conexão: o reenvio só acontece se a conexão morta foi descartada.
      const retry = outboxPublisher({ orm: victimOrm, clock, publisher: sqsPublisher(queueUrl) });
      expect(await within(drain(retry.batch), 5_000, 'resend on the same pool')).toBe(1);
      expect(retry.metrics.counter('outbox_published_total')).toBe(1);
      expect(retry.metrics.counter('outbox_commit_failures_total')).toBe(0);
      const [row] = await sql(`SELECT attempts, published_at FROM outbox WHERE id = ?`, [eventId]);
      expect(row?.attempts).toBe(0); // o reenvio não conta como tentativa falha
      expect(row?.published_at).not.toBeNull();

      // Dois envios do mesmo eventId dentro da janela de 5 min do FIFO: uma mensagem só na fila.
      await expectFullyPublished(queueUrl, created);
    } finally {
      await within(victimOrm.close(true), 3_000, 'orm.close');
    }
  }

  test('session killed right after SendMessageBatch: nothing counted, event still pending, resent once (dedup by eventId), pool slot recovered', async () => {
    await expectCommitFailureRecovered((real) => {
      const killer = new KillSessionAfterSend(real, sql);
      return { publisher: killer, terminated: killer.terminated };
    });
  });

  test('session killed after every UPDATE, so the COMMIT itself fails: same guarantees', async () => {
    const terminated: number[] = [];
    await expectCommitFailureRecovered((real) => ({
      publisher: real,
      wrapUow: (uow) => new KillSessionBeforeCommit(uow, sql, terminated),
      terminated,
    }));
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
    const first = await startApp();
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
    const second = await startApp({ outbox: { enabled: true, pollIntervalMs: 50 }, sqs: { eventsQueueUrl: queueUrl } });
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
    const app = await startApp({ outbox: { enabled: true, pollIntervalMs: 50 }, eventPublisher: gated });
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
