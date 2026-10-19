import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ResolvePendingReference } from '../../src/application/wagering/resolve-pending-reference';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { ManualClock } from './support/outbox';
import {
  createWalletViaApi,
  type HttpResult,
  type SubmissionBody,
  startTestApp,
  submit,
  type TestApp,
  wagerPayload,
  type WalletBody,
} from './support/app';

import { monetaryLeaks } from './support/logs';

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

/**
 * O resolve só age em pendentes vencidas (`next_attempt_at <= now`). Avança o relógio um degrau máximo do
 * backoff (5 min) e resolve, como faria o worker no próximo ciclo. Cada transação criada depois de um avanço
 * herda o relógio atual, então nenhuma chega perto do prazo de 1 h.
 */
async function resolveWhenDue(id: string) {
  clock.advance(DEFAULT_PENDING_REFERENCE_POLICY.backoff.maxMs);
  return resolver.execute(id);
}

afterAll(async () => {
  await api?.close();
  await closeOrm?.();
});

beforeEach(() => api.logger.clear());

// Nenhum log do HTTP traz valor monetário (ARCHITECTURE 11.2).
afterEach(() => {
  expect(monetaryLeaks(api.logger.entries)).toEqual([]);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Submitted {
  payload: Record<string, unknown>;
  result: HttpResult<SubmissionBody>;
  id: string;
}

async function send(wallet: WalletBody, overrides: Record<string, unknown>): Promise<Submitted> {
  const payload = wagerPayload(wallet, overrides);
  const result = await submit(api, payload);
  return { payload, result, id: result.body.transactionId as string };
}

const bet = (w: WalletBody, amount: string, extra: Record<string, unknown> = {}) =>
  send(w, { kind: 'BET', money: brl(amount), ...extra });
const win = (w: WalletBody, amount: string, extra: Record<string, unknown> = {}) =>
  send(w, { kind: 'WIN', money: brl(amount), ...extra });
const reverse = (
  w: WalletBody,
  kind: 'REFUND' | 'ROLLBACK',
  reference: Submitted | string,
  amount: string,
  extra: Record<string, unknown> = {},
) =>
  send(w, {
    kind,
    money: brl(amount),
    referenceExternalTransactionId:
      typeof reference === 'string' ? reference : (reference.payload.externalTransactionId as string),
    ...extra,
  });

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  return row?.balance as string;
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

async function entriesOf(txId: string) {
  return sql(
    `SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE transaction_id = ?`,
    [txId],
  );
}

/** Eventos gravados na outbox para uma transação (WalletBalanceChanged também carrega o transactionId). */
async function eventsOf(txId: string): Promise<string[]> {
  const rows = await sql(
    `SELECT event_type FROM outbox WHERE payload->'data'->>'transactionId' = ? ORDER BY event_type`,
    [txId],
  );
  return rows.map((r) => r.event_type as string);
}

function expectRejected(s: Submitted, failureCode: string, balance: string): void {
  expect(s.result.status).toBe(422);
  expect(s.result.body).toMatchObject({ status: 'REJECTED', failureCode, balance: brl(balance) });
}

describe('REFUND', () => {
  test('of a BET credits the stake back and links the reference', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '30.00');
    const r = await reverse(w, 'REFUND', b, '30.00');
    expect(r.result.status).toBe(200);
    expect(r.result.body).toEqual({
      transactionId: r.id, status: 'PROCESSED', failureCode: null, balance: brl('100.00'), idempotentReplay: false,
    });
    expect(await txRow(r.id)).toMatchObject({ status: 'PROCESSED', reference_transaction_id: b.id });
    expect(await entriesOf(r.id)).toEqual([{ direction: 'CREDIT', amount: '30.00' }]);
    expect(await eventsOf(r.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('of a BET that already had a WIN is allowed: the WIN stands and the stake comes back', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '30.00');
    await win(w, '50.00', { referenceExternalTransactionId: b.payload.externalTransactionId });
    const r = await reverse(w, 'REFUND', b, '30.00');
    expect(r.result.status).toBe(200);
    expect(await balanceOf(w.id)).toBe('150.00');
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '40.00');
    const r = await reverse(w, 'ROLLBACK', b, '40.00');
    expect(r.result.body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(await entriesOf(r.id)).toEqual([{ direction: 'CREDIT', amount: '40.00' }]);
  });

  test('of a WIN debits', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const wn = await win(w, '25.00');
    const r = await reverse(w, 'ROLLBACK', wn, '25.00');
    expect(r.result.body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });
    expect(await entriesOf(r.id)).toEqual([{ direction: 'DEBIT', amount: '25.00' }]);
  });

  test('of a REFUND debits, and the BET stays reversed (a new REFUND is ALREADY_REVERSED)', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '20.00');
    const refund = await reverse(w, 'REFUND', b, '20.00');
    const r = await reverse(w, 'ROLLBACK', refund, '20.00');
    expect(r.result.body).toMatchObject({ status: 'PROCESSED', balance: brl('80.00') });
    expect(await entriesOf(r.id)).toEqual([{ direction: 'DEBIT', amount: '20.00' }]);
    expectRejected(await reverse(w, 'REFUND', b, '20.00'), 'ALREADY_REVERSED', '80.00');
  });
});

describe('reversal rejections: 422, persisted, no ledger entry, balance untouched', () => {
  test('REFERENCE_MISMATCH: reference in another round', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '10.00');
    const r = await reverse(w, 'REFUND', b, '10.00', { roundId: 'round-2' });
    expectRejected(r, 'REFERENCE_MISMATCH', '90.00');
    expect(await entriesOf(r.id)).toEqual([]);
    expect(await txRow(r.id)).toMatchObject({ reference_transaction_id: b.id });
    expect(await eventsOf(r.id)).toEqual(['WagerTransactionRejected']);
  });

  test('REFERENCE_MISMATCH: reference of another player and wallet', async () => {
    const owner = await createWalletViaApi(api, '100.00');
    const other = await createWalletViaApi(api, '100.00');
    const b = await bet(owner, '10.00');
    expectRejected(await reverse(other, 'REFUND', b, '10.00'), 'REFERENCE_MISMATCH', '100.00');
    expect(await balanceOf(owner.id)).toBe('90.00');
  });

  test.each([
    ['REFUND of a WIN', 'REFUND', 'WIN'],
    ['ROLLBACK of a ROLLBACK', 'ROLLBACK', 'ROLLBACK'],
    ['ROLLBACK of a LOSS', 'ROLLBACK', 'LOSS'],
  ] as const)('INVALID_REFERENCE_KIND: %s', async (_label, kind, referenceKind) => {
    const w = await createWalletViaApi(api, '100.00');
    let reference: Submitted;
    if (referenceKind === 'ROLLBACK') {
      const b = await bet(w, '10.00');
      reference = await reverse(w, 'ROLLBACK', b, '10.00');
    } else {
      reference = await send(w, { kind: referenceKind, money: brl('10.00') });
    }
    expect(reference.result.status).toBe(200);
    const before = await balanceOf(w.id);
    const r = await reverse(w, kind, reference, '10.00');
    expectRejected(r, 'INVALID_REFERENCE_KIND', before);
    expect(await entriesOf(r.id)).toEqual([]);
  });

  test('ROLLBACK of the OPENING is unreachable: it never resolves, so it waits and never moves the balance', async () => {
    // A OPENING usa o provider reservado `internal`, e a busca da referência é por (providerId do pedido, id
    // externo): um provedor nunca a encontra. A reversão fica PENDING_REFERENCE até o limite do worker.
    const w = await createWalletViaApi(api, '100.00');
    const r = await reverse(w, 'ROLLBACK', `opening:${w.id}`, '100.00');
    expect(r.result.status).toBe(202);
    expect((await resolveWhenDue(r.id)).outcome).toBe('still_pending');
    expect(await balanceOf(w.id)).toBe('100.00');
  });

  test('CURRENCY_MISMATCH: a reversal in another currency stops at the wallet check', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '10.00');
    const r = await send(w, {
      kind: 'REFUND', money: { amount: '10.00', currency: 'USD' },
      referenceExternalTransactionId: b.payload.externalTransactionId,
    });
    expectRejected(r, 'CURRENCY_MISMATCH', '90.00');
  });

  test('AMOUNT_MISMATCH: partial reversal is out of scope', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '30.00');
    expectRejected(await reverse(w, 'REFUND', b, '20.00'), 'AMOUNT_MISMATCH', '70.00');
  });

  test('REFERENCE_NOT_PROCESSED: the referenced BET was REJECTED', async () => {
    const w = await createWalletViaApi(api, '10.00');
    const b = await bet(w, '50.00');
    expect(b.result.status).toBe(422);
    expectRejected(await reverse(w, 'REFUND', b, '50.00'), 'REFERENCE_NOT_PROCESSED', '10.00');
  });

  test('ALREADY_REVERSED: REFUND then ROLLBACK of the same BET, and a second REFUND with another id', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '30.00');
    await reverse(w, 'REFUND', b, '30.00');
    const rollback = await reverse(w, 'ROLLBACK', b, '30.00');
    expectRejected(rollback, 'ALREADY_REVERSED', '100.00');
    expect(await txRow(rollback.id)).toMatchObject({ reference_transaction_id: b.id });
    expectRejected(await reverse(w, 'REFUND', b, '30.00'), 'ALREADY_REVERSED', '100.00');
  });

  test('REVERSAL_WOULD_OVERDRAW, distinct from INSUFFICIENT_FUNDS; a later legitimate reversal still goes through', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const wn = await win(w, '50.00');
    await bet(w, '150.00');
    const r = await reverse(w, 'ROLLBACK', wn, '50.00');
    expectRejected(r, 'REVERSAL_WOULD_OVERDRAW', '0.00');
    expect(await entriesOf(r.id)).toEqual([]);

    // O índice anti-dupla-reversão só conta PROCESSED: a rejeição não bloqueia uma nova tentativa.
    await win(w, '50.00');
    const retry = await reverse(w, 'ROLLBACK', wn, '50.00');
    expect(retry.result.body).toMatchObject({ status: 'PROCESSED', balance: brl('0.00') });
  });
});

describe('replay of reversals', () => {
  test('PROCESSED replays as 200 with the balance of that time', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '30.00');
    const r = await reverse(w, 'REFUND', b, '30.00');
    await win(w, '5.00');
    const replay = await submit(api, r.payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...r.result.body, idempotentReplay: true });
  });

  test('REJECTED replays as the same 422', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '30.00');
    const r = await reverse(w, 'REFUND', b, '1.00');
    const replay = await submit(api, r.payload);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...r.result.body, idempotentReplay: true });
  });

  test('same key with a different reference is a 409', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '30.00');
    const r = await reverse(w, 'REFUND', b, '30.00');
    const conflict = await submit(api, { ...r.payload, referenceExternalTransactionId: 'ext-other' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});

describe('reversal before its reference (PENDING_REFERENCE)', () => {
  test('202 and one PendingReference event; retries are silent; once the BET arrives it resolves; replay follows the current state', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const r = await reverse(w, 'REFUND', betExternalId, '30.00');
    expect(r.result.status).toBe(202);
    expect(r.result.body).toEqual({
      transactionId: r.id, status: 'PENDING_REFERENCE', failureCode: null, balance: null, idempotentReplay: false,
    });
    expect(await txRow(r.id)).toMatchObject({
      status: 'PENDING_REFERENCE', attempts: 0, scheduled: true, reference_transaction_id: null, balance_after: null,
    });
    expect(await eventsOf(r.id)).toEqual(['WagerTransactionPendingReference']);

    const pendingReplay = await submit(api, r.payload);
    expect(pendingReplay.status).toBe(202);
    expect(pendingReplay.body).toEqual({ ...r.result.body, idempotentReplay: true });

    // Antes do vencimento, o resolve não conta tentativa nenhuma.
    expect(await resolver.execute(r.id)).toMatchObject({ outcome: 'noop', reason: 'not_due' });
    expect(await txRow(r.id)).toMatchObject({ attempts: 0 });

    expect((await resolveWhenDue(r.id)).outcome).toBe('still_pending');
    expect(await txRow(r.id)).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 1, scheduled: true });
    expect(await eventsOf(r.id)).toEqual(['WagerTransactionPendingReference']);

    const b = await bet(w, '30.00', { externalTransactionId: betExternalId });
    expect(b.result.body).toMatchObject({ status: 'PROCESSED', balance: brl('70.00') });

    const resolved = await resolveWhenDue(r.id);
    expect(resolved.outcome).toBe('resolved');
    expect(await txRow(r.id)).toMatchObject({
      status: 'PROCESSED', balance_after: '100.00', reference_transaction_id: b.id, scheduled: false,
    });
    expect(await entriesOf(r.id)).toEqual([{ direction: 'CREDIT', amount: '30.00' }]);
    expect(await eventsOf(r.id)).toEqual([
      'WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
    expect(await balanceOf(w.id)).toBe('100.00');

    const finalReplay = await submit(api, r.payload);
    expect(finalReplay.status).toBe(200);
    expect(finalReplay.body).toMatchObject({ status: 'PROCESSED', balance: brl('100.00'), idempotentReplay: true });

    expect(await resolveWhenDue(r.id)).toMatchObject({ outcome: 'noop', reason: 'not_pending' });
  });

  test('a reference that is itself PENDING_REFERENCE counts as absent', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const pendingRefund = await reverse(w, 'REFUND', `ext-${Bun.randomUUIDv7()}`, '10.00');
    const rollback = await reverse(w, 'ROLLBACK', pendingRefund, '10.00');
    expect(rollback.result.status).toBe(202);
  });

  test('a pending reversal whose reference arrives REJECTED resolves to REFERENCE_NOT_PROCESSED', async () => {
    const w = await createWalletViaApi(api, '10.00');
    const betExternalId = `ext-${Bun.randomUUIDv7()}`;
    const r = await reverse(w, 'REFUND', betExternalId, '50.00');
    await bet(w, '50.00', { externalTransactionId: betExternalId });
    const resolved = await resolveWhenDue(r.id);
    expect(resolved.outcome).toBe('resolved');
    expect(await txRow(r.id)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED' });
    expect(await eventsOf(r.id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });

  test('a reference from another provider is never found', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '10.00');
    const r = await reverse(w, 'REFUND', b, '10.00', { providerId: 'provider-b' });
    expect(r.result.status).toBe(202);
  });

  test('resolving a transaction that is not pending, or does not exist, is a no-op', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const b = await bet(w, '10.00');
    expect(await resolver.execute(b.id)).toMatchObject({ outcome: 'noop', reason: 'not_pending' });
    expect(await resolver.execute(Bun.randomUUIDv7())).toMatchObject({ outcome: 'noop', reason: 'not_found' });
  });
});

describe('invariant', () => {
  test('every wallet balance equals the balance rebuilt from the ledger', async () => {
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });
});
