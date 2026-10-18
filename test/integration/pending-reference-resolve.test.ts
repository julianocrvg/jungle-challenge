import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ResolvePendingReference } from '../../src/application/wagering/resolve-pending-reference';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload, type WalletBody } from './support/app';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { monetaryLeaks } from './support/logs';
import { ManualClock } from './support/outbox';

/*
 * ResolvePendingReference contra o Postgres real (ARCHITECTURE 8): vencimento, um único incremento com dois
 * resolves simultâneos, expiração por prazo e por tentativas, e a cadeia ROLLBACK -> REFUND -> BET ausente.
 * Relógio manual: nada depende do tempo real. Todo teste termina com saldo == ledger e nenhum valor em log.
 */

const ROUNDS = 10;
const STEP = DEFAULT_PENDING_REFERENCE_POLICY.backoff.maxMs;
const TTL = DEFAULT_PENDING_REFERENCE_POLICY.ttlMs;

let api: TestApp;
let sql: Sql;
let resolver: ResolvePendingReference;
let closeOrm: () => Promise<void>;
const clock = new ManualClock(new Date());

beforeAll(async () => {
  const orm = await createTestOrm();
  sql = sqlRunner(orm);
  closeOrm = () => orm.close(true);
  api = await startTestApp({ clock });
  resolver = api.app.get(ResolvePendingReference);
});

afterAll(async () => {
  await api?.close();
  await closeOrm?.();
});

beforeEach(() => api.logger.clear());

afterEach(async () => {
  expect(monetaryLeaks(api.logger.entries)).toEqual([]);
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function reversal(w: WalletBody, kind: 'REFUND' | 'ROLLBACK', referenceExternalId: string, amount: string) {
  const payload = wagerPayload(w, { kind, money: brl(amount), referenceExternalTransactionId: referenceExternalId });
  const result = await submit(api, payload);
  expect(result.status).toBe(202);
  return { id: result.body.transactionId as string, externalId: payload.externalTransactionId as string, payload };
}

async function txRow(id: string) {
  const [row] = await sql(
    `SELECT status, failure_code, balance_after::text AS balance_after, reference_transaction_id, attempts,
            next_attempt_at IS NOT NULL AS scheduled
     FROM wager_transactions WHERE id = ?`,
    [id],
  );
  return row;
}

async function eventsOf(transactionId: string): Promise<string[]> {
  const rows = await sql(
    `SELECT event_type FROM outbox WHERE payload->'data'->>'transactionId' = ? ORDER BY occurred_at, id`,
    [transactionId],
  );
  return rows.map((r) => r.event_type as string);
}

async function rejectedEventOf(transactionId: string): Promise<Record<string, unknown>> {
  const [row] = await sql(
    `SELECT payload FROM outbox WHERE event_type = 'WagerTransactionRejected' AND payload->'data'->>'transactionId' = ?`,
    [transactionId],
  );
  return (row?.payload as { data: Record<string, unknown> }).data;
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  return row?.balance as string;
}

async function entriesOf(walletId: string): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]);
  return row?.n as number;
}

describe('due date', () => {
  test('two resolves on the same due pending: one counts the attempt, the other sees not_due; attempts goes up once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = await createWalletViaApi(api, '100.00');
      const r = await reversal(w, 'REFUND', `ext-${Bun.randomUUIDv7()}`, '10.00');
      clock.advance(STEP);
      const outcomes = await Promise.all([resolver.execute(r.id), resolver.execute(r.id)]);
      expect(outcomes.map((o) => (o.outcome === 'noop' ? `noop:${o.reason}` : o.outcome)).sort())
        .toEqual(['noop:not_due', 'still_pending']);
      expect(await txRow(r.id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1, scheduled: true });
      expect(await eventsOf(r.id)).toEqual(['WagerTransactionPendingReference']);
    }
  });
});

describe('expiration by TTL', () => {
  test('reference never arrives: REJECTED REFERENCE_NOT_FOUND with the balance observed under the lock, Rejected in the outbox', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const r = await reversal(w, 'REFUND', `ext-${Bun.randomUUIDv7()}`, '10.00');
    // O saldo muda depois da entrada da reversão: o observado tem de ser o do momento da expiração.
    expect((await submit(api, wagerPayload(w, { money: brl('25.00') }))).status).toBe(200);

    clock.advance(TTL);
    const outcome = await resolver.execute(r.id);
    expect(outcome.outcome).toBe('expired');
    expect(await txRow(r.id)).toMatchObject({
      status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', balance_after: '75.00',
      reference_transaction_id: null, scheduled: false,
    });
    expect(await eventsOf(r.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await rejectedEventOf(r.id)).toMatchObject({ failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await balanceOf(w.id)).toBe('75.00');
    expect(await entriesOf(w.id)).toBe(2); // abertura e a aposta; a reversão expirada não lança nada

    // O replay devolve o resultado final, com o saldo observado na expiração, e um novo resolve é no-op.
    const replay = await submit(api, r.payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND', balance: brl('75.00'), idempotentReplay: true,
    });
    expect(await resolver.execute(r.id)).toMatchObject({ outcome: 'noop', reason: 'not_pending' });
  });

  test('a reference that arrived before the attempt is applied even past the deadline: resolving comes first', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const r = await reversal(w, 'REFUND', betExternalId, '10.00');
    clock.advance(TTL);
    expect((await submit(api, wagerPayload(w, { externalTransactionId: betExternalId, money: brl('10.00') }))).status).toBe(200);
    expect((await resolver.execute(r.id)).outcome).toBe('resolved');
    expect(await txRow(r.id)).toMatchObject({ status: 'PROCESSED', balance_after: '100.00' });
    expect(await balanceOf(w.id)).toBe('100.00');
  });
});

describe('expiration by attempts, with the TTL still far', () => {
  test('maxAttempts = 3: two attempts are rescheduled, the third expires', async () => {
    const strict = await startTestApp({ clock, pendingReference: { maxAttempts: 3 } });
    try {
      const strictResolver = strict.app.get(ResolvePendingReference);
      const w = await createWalletViaApi(strict, '100.00');
      const payload = wagerPayload(w, { kind: 'ROLLBACK', money: brl('10.00'), referenceExternalTransactionId: 'ext-never' });
      const id = (await submit(strict, payload)).body.transactionId as string;

      clock.advance(STEP);
      expect((await strictResolver.execute(id)).outcome).toBe('still_pending');
      clock.advance(STEP);
      expect((await strictResolver.execute(id)).outcome).toBe('still_pending');
      expect(await txRow(id)).toMatchObject({ attempts: 2, status: 'PENDING_REFERENCE' });
      clock.advance(STEP);
      // 15 min depois da criação: muito antes de 1 h.
      expect((await strictResolver.execute(id)).outcome).toBe('expired');
      expect(await txRow(id)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', attempts: 2 });
      expect(await balanceOf(w.id)).toBe('100.00');
    } finally {
      await strict.close();
    }
  });
});

describe('chain ROLLBACK -> REFUND -> BET that never arrives', () => {
  test.each([
    ['REFUND first', ['refund', 'rollback'] as const],
    ['ROLLBACK first', ['rollback', 'refund'] as const],
  ])('%s: REFUND ends REFERENCE_NOT_FOUND, ROLLBACK ends REFERENCE_NOT_PROCESSED linked to the REFUND; no money moves', async (_label, order) => {
    const w = await createWalletViaApi(api, '100.00');
    const refund = await reversal(w, 'REFUND', `ext-${Bun.randomUUIDv7()}`, '10.00');
    const rollback = await reversal(w, 'ROLLBACK', refund.externalId, '10.00');

    clock.advance(TTL);
    const ids = { refund: refund.id, rollback: rollback.id };
    for (const link of order) await resolver.execute(ids[link]);

    expect(await txRow(refund.id)).toMatchObject({
      status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_transaction_id: null, balance_after: '100.00',
    });
    expect(await txRow(rollback.id)).toMatchObject({
      status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED', reference_transaction_id: refund.id, balance_after: '100.00',
    });
    expect(await eventsOf(rollback.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await balanceOf(w.id)).toBe('100.00');
    expect(await entriesOf(w.id)).toBe(1); // só a abertura
  });
});
