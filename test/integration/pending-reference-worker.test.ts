import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { InMemoryMetrics } from '../../src/infrastructure/metrics/in-memory-metrics';
import { PendingReferenceWorker } from '../../src/interface/workers/pending-reference.worker';
import {
  CapturingLogger, createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload, type WalletBody,
} from './support/app';
import { holdWalletLock } from './support/consumer';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { monetaryLeaks } from './support/logs';
import {
  createTempFifoQueue,
  deleteQueue,
  drain,
  ManualClock,
  outboxPublisher,
  receiveAll,
  SQS,
  sqsPublisher,
  waitFor,
} from './support/outbox';

/*
 * Worker de PENDING_REFERENCE contra Postgres e LocalStack reais (ARCHITECTURE 8). Os ciclos são chamados
 * direto (`runOnce`) com relógio manual; os testes de reinício e shutdown sobem o laço de verdade e esperam
 * por polling com prazo. Todo teste termina com saldo == ledger e nenhum valor monetário nos logs.
 */

const STEP = DEFAULT_PENDING_REFERENCE_POLICY.backoff.maxMs;
const TTL = DEFAULT_PENDING_REFERENCE_POLICY.ttlMs;

let orm: MikroORM;
let sql: Sql;
let client: SQSClient;
let api: TestApp;
let worker: PendingReferenceWorker;
let metrics: InMemoryMetrics;
const clock = new ManualClock(new Date());
/** Um logger para todos os apps deste arquivo: o logger do Nest é estático e iria para o último app criado. */
const logs = new CapturingLogger();
/** Apps extras de cada teste (segundo worker, reinício): fechadas no afterEach. */
const extraApps: TestApp[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  client = createSqsClient(SQS);
  metrics = new InMemoryMetrics();
  api = await startTestApp({ clock, metrics, logger: logs });
  worker = api.app.get(PendingReferenceWorker);
});

afterAll(async () => {
  await api?.close();
  client?.destroy();
  await orm?.close(true);
});

beforeEach(() => logs.clear());

afterEach(async () => {
  await Promise.all(extraApps.splice(0).map((a) => a.close()));
  // Nenhum log (do worker, do HTTP ou do Nest) traz valores monetários.
  expect(monetaryLeaks(logs.entries)).toEqual([]);
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
});

/** App de outra instância: mesmo banco, pool próprio, mesmo relógio e mesmo logger. */
function instance(options: Parameters<typeof startTestApp>[0] = {}): Promise<TestApp> {
  return startTestApp({ clock, logger: logs, ...options });
}

async function extraApp(options: Parameters<typeof startTestApp>[0] = {}): Promise<TestApp> {
  const app = await instance(options);
  extraApps.push(app);
  return app;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function reversal(w: WalletBody, kind: 'REFUND' | 'ROLLBACK', referenceExternalId: string, amount: string) {
  const payload = wagerPayload(w, { kind, money: brl(amount), referenceExternalTransactionId: referenceExternalId });
  const result = await submit(api, payload);
  expect(result.status).toBe(202);
  return { id: result.body.transactionId as string, externalId: payload.externalTransactionId as string };
}

async function bet(w: WalletBody, externalTransactionId: string, amount: string) {
  const result = await submit(api, wagerPayload(w, { externalTransactionId, money: brl(amount) }));
  expect(result.status).toBe(200);
  return result.body.transactionId as string;
}

async function txRow(id: string) {
  const [row] = await sql(
    `SELECT status, failure_code, balance_after::text AS balance_after, reference_transaction_id, attempts
     FROM wager_transactions WHERE id = ?`,
    [id],
  );
  return row;
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  return row?.balance as string;
}

async function entriesOf(walletId: string): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]);
  return row?.n as number;
}

async function pendingCount(): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`);
  return row?.n as number;
}

/** Publica toda a outbox pendente numa fila FIFO temporária e devolve os eventos recebidos dela. */
async function publishAndReceive(expectedAtLeast: number) {
  const queueUrl = await createTempFifoQueue(client, 'pending-worker');
  try {
    const { batch } = outboxPublisher({ orm, clock, publisher: sqsPublisher(queueUrl) });
    const published = await drain(batch);
    expect(published).toBeGreaterThanOrEqual(expectedAtLeast);
    return await receiveAll(client, queueUrl, published);
  } finally {
    await deleteQueue(client, queueUrl);
  }
}

describe('a cycle of the worker', () => {
  test('the reversal resolves once its reference arrives, and its events reach SQS', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const refund = await reversal(w, 'REFUND', betExternalId, '30.00');

    // Ainda não venceu: o ciclo não lista nada desta linha.
    expect((await worker.runOnce()).listed).toBe(0);
    clock.advance(STEP);
    expect(await worker.runOnce()).toEqual({ listed: 1, failed: 0 });
    expect(await txRow(refund.id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });

    await bet(w, betExternalId, '30.00');
    clock.advance(STEP);
    expect(await worker.runOnce()).toEqual({ listed: 1, failed: 0 });
    expect(await txRow(refund.id)).toMatchObject({ status: 'PROCESSED', balance_after: '100.00' });
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(metrics.counter('pending_reference_resolved_total', { status: 'PROCESSED' })).toBe(1);
    expect(metrics.gaugeValue('pending_reference_pending')).toBe(0);
    expect(metrics.gaugeValue('pending_reference_oldest_age_seconds')).toBe(0);

    const events = await publishAndReceive(4);
    const ofRefund = events.filter((e) => (e.body.data as Record<string, unknown>).transactionId === refund.id);
    expect(ofRefund.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
  });

  test('two workers in separate apps (separate pools) on the same due pending: attempts goes up exactly once', async () => {
    const otherMetrics = new InMemoryMetrics();
    const other = (await extraApp({ metrics: otherMetrics })).app.get(PendingReferenceWorker);
    const retriesBefore = metrics.counter('pending_reference_retries_total');
    const notDueBefore = metrics.counter('pending_reference_noop_total', { reason: 'not_due' });

    for (let round = 0; round < 10; round++) {
      const w = await createWalletViaApi(api, '100.00');
      const r = await reversal(w, 'ROLLBACK', `ext-${Bun.randomUUIDv7()}`, '10.00');
      clock.advance(STEP);
      const before = await pendingCount();
      await Promise.all([worker.runOnce(), other.runOnce()]);
      expect(await txRow(r.id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });
      expect(await pendingCount()).toBe(before);
    }
    // Cada linha vencida é contada uma vez por vencimento, somando os dois workers; o resto é not_due.
    const retries = metrics.counter('pending_reference_retries_total') - retriesBefore
      + otherMetrics.counter('pending_reference_retries_total');
    const notDue = metrics.counter('pending_reference_noop_total', { reason: 'not_due' }) - notDueBefore
      + otherMetrics.counter('pending_reference_noop_total', { reason: 'not_due' });
    const [{ total }] = (await sql(`SELECT sum(attempts)::int AS total FROM wager_transactions WHERE kind = 'ROLLBACK'`)) as [{ total: number }];
    expect(retries).toBe(total);
    expect(notDue).toBeGreaterThan(0);
  });

  test('TTL exhausted: REJECTED REFERENCE_NOT_FOUND, Rejected event in the outbox and then in SQS', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const r = await reversal(w, 'REFUND', `ext-${Bun.randomUUIDv7()}`, '10.00');
    clock.advance(TTL);
    // As pendentes que sobraram dos testes anteriores também expiram neste ciclo.
    while ((await worker.runOnce()).listed > 0);

    expect(await txRow(r.id)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', balance_after: '100.00' });
    const [outboxRow] = await sql(
      `SELECT published_at FROM outbox WHERE event_type = 'WagerTransactionRejected' AND payload->'data'->>'transactionId' = ?`,
      [r.id],
    );
    expect(outboxRow).toMatchObject({ published_at: null });
    expect(metrics.counter('pending_reference_expired_total', { failureCode: 'REFERENCE_NOT_FOUND' })).toBeGreaterThanOrEqual(1);
    expect(await pendingCount()).toBe(0);
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await entriesOf(w.id)).toBe(1);
    // O log do worker chegou ao logger capturado (então a checagem de valores do afterEach o cobre).
    expect(logs.entries.some((e) => e.message.includes('Pending reference expired'))).toBe(true);
    // Cada ciclo do worker abre um contexto de log com correlationId próprio (ARCHITECTURE 11.3).
    const expiredLog = logs.entries.find((e) => e.message.includes('Pending reference expired'));
    expect(JSON.parse(expiredLog!.message).correlationId).toMatch(/^[0-9a-f-]{36}$/);

    const events = await publishAndReceive(1);
    const rejected = events.find((e) => e.eventType === 'WagerTransactionRejected'
      && (e.body.data as Record<string, unknown>).transactionId === r.id);
    expect((rejected?.body.data as Record<string, unknown>).failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  test('chain ROLLBACK of a REFUND that waits for the BET: converges in cycles once the BET arrives', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const refund = await reversal(w, 'REFUND', betExternalId, '30.00');
    const rollback = await reversal(w, 'ROLLBACK', refund.externalId, '30.00');

    clock.advance(STEP);
    await worker.runOnce();
    expect(await txRow(refund.id)).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(await txRow(rollback.id)).toMatchObject({ status: 'PENDING_REFERENCE' });

    await bet(w, betExternalId, '30.00');
    let cycles = 0;
    while (((await txRow(rollback.id)) as { status: string }).status === 'PENDING_REFERENCE') {
      expect(cycles).toBeLessThan(5);
      clock.advance(STEP);
      await worker.runOnce();
      cycles += 1;
    }
    // Na ordem favorável, um ciclo; se o ROLLBACK for avaliado antes do REFUND, ele espera mais um.
    expect(cycles).toBeLessThanOrEqual(2);
    expect(await txRow(refund.id)).toMatchObject({ status: 'PROCESSED', balance_after: '100.00' });
    expect(await txRow(rollback.id)).toMatchObject({ status: 'PROCESSED', reference_transaction_id: refund.id, balance_after: '70.00' });
    expect(await balanceOf(w.id)).toBe('70.00');
    expect(await entriesOf(w.id)).toBe(4); // abertura, aposta, REFUND, ROLLBACK
  });
});

describe('the worker loop', () => {
  test('restart: a worker stopped with the pending row is replaced by a new instance that resolves it', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const refund = await reversal(w, 'REFUND', betExternalId, '20.00');

    const firstMetrics = new InMemoryMetrics();
    const first = await instance({ metrics: firstMetrics, pendingReference: { enabled: true, pollIntervalMs: 50 } });
    clock.advance(STEP);
    await waitFor(async () => (await txRow(refund.id))?.attempts as number, (n) => n === 1);
    await first.close();
    expect(firstMetrics.counter('pending_reference_retries_total')).toBe(1);
    expect(await txRow(refund.id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1 });

    await bet(w, betExternalId, '20.00');
    await extraApp({ pendingReference: { enabled: true, pollIntervalMs: 50 } });
    clock.advance(STEP);
    await waitFor(async () => (await txRow(refund.id))?.status as string, (s) => s === 'PROCESSED');
    expect(await balanceOf(w.id)).toBe('100.00');
  });

  test('shutdown waits for the resolve in progress to commit and starts no new row', async () => {
    const blockedWallet = await createWalletViaApi(api, '100.00');
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const blocked = await reversal(blockedWallet, 'REFUND', betExternalId, '10.00');
    await bet(blockedWallet, betExternalId, '10.00');
    const otherWallet = await createWalletViaApi(api, '100.00');
    clock.advance(1); // next_attempt_at da segunda depois da primeira: ela vem depois na listagem
    const untouched = await reversal(otherWallet, 'REFUND', `ext-${Bun.randomUUIDv7()}`, '10.00');

    const lock = await holdWalletLock(orm, blockedWallet.id);
    const app = await instance({ pendingReference: { enabled: true, concurrency: 1, pollIntervalMs: 50 } });
    clock.advance(STEP);
    // O resolve da primeira está na fila do FOR UPDATE.
    await waitFor(
      async () => (await sql(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'`))[0]?.n as number,
      (n) => n >= 1,
    );

    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    // O close não termina enquanto o resolve em andamento espera o lock.
    await sql('SELECT 1');
    expect(closed).toBe(false);

    await lock.release();
    await closing;
    // O resolve em andamento fez commit antes de o pool fechar...
    expect(await txRow(blocked.id)).toMatchObject({ status: 'PROCESSED' });
    // ...e a segunda linha, já listada, não foi iniciada.
    expect(await txRow(untouched.id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0 });
    expect(await balanceOf(blockedWallet.id)).toBe('100.00');
  });
});
