import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import {
  createWalletViaApi,
  startTestApp,
  submit,
  type TestApp,
  wagerPayload,
  type WalletBody,
} from './support/app';

let api: TestApp;
let sql: Sql;
let closeOrm: () => Promise<void>;

beforeAll(async () => {
  const orm = await createTestOrm();
  sql = sqlRunner(orm);
  closeOrm = () => orm.close(true);
  api = await startTestApp();
});

afterAll(async () => {
  await api?.close();
  await closeOrm?.();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function walletRow(walletId: string) {
  const [row] = await sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [walletId]);
  return row;
}

/** Contagens do que uma wallet tem gravado: transações, lançamentos e eventos na outbox. */
async function footprint(walletId: string) {
  const [row] = await sql(
    `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = ?)::int AS transactions,
            (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::int AS entries,
            (SELECT count(*) FROM outbox WHERE aggregate_id = ?)::int AS events`,
    [walletId, walletId, walletId],
  );
  return row;
}

async function eventTypes(walletId: string): Promise<string[]> {
  const rows = await sql(`SELECT event_type FROM outbox WHERE aggregate_id = ? ORDER BY event_type`, [walletId]);
  return rows.map((r) => r.event_type as string);
}

let wallet: WalletBody;

describe('BET, WIN and LOSS', () => {
  beforeAll(async () => {
    wallet = await createWalletViaApi(api, '1000.00');
  });

  test('BET debits: 200 PROCESSED with the new balance, one DEBIT entry, wallet version 2', async () => {
    const result = await submit(api, wagerPayload(wallet, { money: brl('25.00') }));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      transactionId: expect.any(String), status: 'PROCESSED', failureCode: null, balance: brl('975.00'),
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '975.00', version: 2 });
    const [entry] = await sql(
      `SELECT direction, amount::text AS amount, wallet_version FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [result.body.transactionId],
    );
    expect(entry).toEqual({ direction: 'DEBIT', amount: '25.00', wallet_version: 2 });
  });

  test('WIN credits', async () => {
    const result = await submit(api, wagerPayload(wallet, { kind: 'WIN', money: brl('100.00') }));
    expect(result.status).toBe(200);
    expect(result.body.balance).toEqual(brl('1075.00'));
    expect(await walletRow(wallet.id)).toEqual({ balance: '1075.00', version: 3 });
  });

  test('LOSS is PROCESSED without touching balance, version or ledger, and accepts zero', async () => {
    const before = await footprint(wallet.id);
    const result = await submit(api, wagerPayload(wallet, { kind: 'LOSS', money: brl('0.00') }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'PROCESSED', failureCode: null, balance: brl('1075.00') });
    expect(await walletRow(wallet.id)).toEqual({ balance: '1075.00', version: 3 });
    const after = await footprint(wallet.id);
    expect(after?.entries).toBe(before?.entries);
    expect(after?.transactions).toBe((before?.transactions as number) + 1);
  });

  test('BET over the balance: 422 INSUFFICIENT_FUNDS, persisted as REJECTED with the observed balance', async () => {
    const result = await submit(api, wagerPayload(wallet, { money: brl('5000.00') }));
    expect(result.status).toBe(422);
    expect(result.body).toEqual({
      transactionId: expect.any(String), status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('1075.00'), idempotentReplay: false,
    });
    const [row] = await sql(
      `SELECT status, failure_code, balance_after::text AS balance_after FROM wager_transactions WHERE id = ?`,
      [result.body.transactionId],
    );
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', balance_after: '1075.00' });
    expect(await walletRow(wallet.id)).toEqual({ balance: '1075.00', version: 3 });
  });
});

describe('outbox in the same transaction', () => {
  test('BET writes WagerTransactionProcessed and WalletBalanceChanged; LOSS and REJECTED write only their own event', async () => {
    const w = await createWalletViaApi(api, '100.00');
    await submit(api, wagerPayload(w, { money: brl('10.00') }));
    expect(await eventTypes(w.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);

    const loss = await createWalletViaApi(api, '100.00');
    await submit(api, wagerPayload(loss, { kind: 'LOSS', money: brl('10.00') }));
    expect(await eventTypes(loss.id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    const rejected = await createWalletViaApi(api, '1.00');
    await submit(api, wagerPayload(rejected, { money: brl('10.00') }));
    expect(await eventTypes(rejected.id)).toEqual(['WagerTransactionRejected', 'WalletBalanceChanged']);
  });

  test('the event carries money as strings and the correlation id of the request', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(w, { money: brl('10.00') });
    await api.post('/wagering/transactions', payload, {
      'idempotency-key': `provider-a:${payload.externalTransactionId}`, 'x-correlation-id': 'corr-123',
    });
    const [row] = await sql(
      `SELECT payload FROM outbox WHERE aggregate_id = ? AND event_type = 'WagerTransactionProcessed'`, [w.id],
    );
    const event = row?.payload as { correlationId: string; data: { money: unknown; balanceAfter: unknown } };
    expect(event.correlationId).toBe('corr-123');
    expect(event.data.money).toEqual(brl('10.00'));
    expect(event.data.balanceAfter).toEqual(brl('90.00'));
  });
});

describe('idempotency', () => {
  test('an identical request is a replay: same body and status, idempotentReplay true, the balance of that time', async () => {
    const w = await createWalletViaApi(api, '1000.00');
    const payload = wagerPayload(w, { money: brl('25.00') });
    const first = await submit(api, payload);
    await submit(api, wagerPayload(w, { kind: 'WIN', money: brl('10.00') }));

    // Mesmos campos em outra ordem: o JSON canônico dá o mesmo hash.
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    const replay = await submit(api, reordered, `provider-a:${payload.externalTransactionId}`);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(brl('975.00'));
    expect(await walletRow(w.id)).toEqual({ balance: '985.00', version: 3 });
  });

  test('a REJECTED transaction replays as the same 422', async () => {
    const w = await createWalletViaApi(api, '10.00');
    const payload = wagerPayload(w, { money: brl('80.00') });
    const first = await submit(api, payload);
    const replay = await submit(api, payload);
    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('same key with a different payload is a 409 IDEMPOTENCY_KEY_CONFLICT, and nothing is written', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(w, { money: brl('10.00') });
    await submit(api, payload);
    const before = await footprint(w.id);

    const conflict = await submit(api, { ...payload, money: brl('11.00') });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ code: 'IDEMPOTENCY_KEY_CONFLICT', message: expect.any(String) });
    expect(await footprint(w.id)).toEqual(before);
    expect(await walletRow(w.id)).toEqual({ balance: '90.00', version: 2 });
  });

  test('a custom Idempotency-Key is the source of truth', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(w, { money: brl('10.00') });
    const first = await submit(api, payload, 'my-own-key-1');
    const replay = await submit(api, payload, 'my-own-key-1');
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('same externalTransactionId with another key: 409 by wt_provider_external_uq, nothing written', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(w, { money: brl('10.00') });
    await submit(api, payload);
    const before = await footprint(w.id);

    const result = await submit(api, payload, 'a-different-key');
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('EXTERNAL_TRANSACTION_ID_CONFLICT');
    expect(await footprint(w.id)).toEqual(before);
  });

  test('a unique violation on any other constraint is a 500 INTERNAL_ERROR, logged with the constraint name', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const taken = await submit(api, wagerPayload(w, { money: brl('10.00') }));
    const before = await footprint(w.id);

    // Com o correlationId vindo no header, o próximo id gerado é o da transação: ele colide com a PK
    // de uma transação existente.
    api.ids.enqueue(taken.body.transactionId as string);
    const payload = wagerPayload(w, { money: brl('10.00') });
    const result = await api.post('/wagering/transactions', payload, {
      'idempotency-key': `provider-a:${payload.externalTransactionId}`, 'x-correlation-id': 'corr-pk-collision',
    });

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal error' });
    expect(await footprint(w.id)).toEqual(before);
    const logged = api.logger.entries.filter((e) => e.level === 'error' && e.message.includes('wager_transactions_pkey'));
    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toContain('"sqlState":"23505"');
  });
});

describe('rejections that need the wallet', () => {
  test('a transaction for a wallet that does not exist is a 404 and writes nothing', async () => {
    const ghost: WalletBody = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), balance: brl('0.00'), version: 1 };
    const result = await submit(api, wagerPayload(ghost));
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('WALLET_NOT_FOUND');
    const [row] = await sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ?`, [ghost.id]);
    expect(row?.n).toBe(0);
  });

  test('another currency: 422 CURRENCY_MISMATCH, observed balance in the wallet currency, replayable', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(w, { money: { amount: '10.00', currency: 'USD' } });
    const result = await submit(api, payload);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: brl('100.00') });
    const replay = await submit(api, payload);
    expect(replay.body).toEqual({ ...result.body, idempotentReplay: true });
    expect(await walletRow(w.id)).toEqual({ balance: '100.00', version: 1 });
  });

  test('another player: 422 PLAYER_MISMATCH, persisted as REJECTED, no balance change', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const result = await submit(api, wagerPayload(w, { playerId: Bun.randomUUIDv7() }));
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ status: 'REJECTED', failureCode: 'PLAYER_MISMATCH', balance: brl('100.00') });
    const [row] = await sql(`SELECT status, failure_code FROM wager_transactions WHERE id = ?`, [result.body.transactionId]);
    expect(row).toEqual({ status: 'REJECTED', failure_code: 'PLAYER_MISMATCH' });
    expect(await walletRow(w.id)).toEqual({ balance: '100.00', version: 1 });
  });
});

describe('request validation', () => {
  beforeAll(async () => {
    wallet = await createWalletViaApi(api, '100.00');
  });

  test('a missing Idempotency-Key is a 400', async () => {
    const result = await api.post('/wagering/transactions', wagerPayload(wallet));
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_PAYLOAD');
  });

  test.each([
    ['too long', 'k'.repeat(256)],
    ['with a space', 'provider-a: key'],
    ['with the reserved prefix', 'internal:opening:x'],
    ['with the reserved prefix in another case', 'INTERNAL:x'],
  ])('an Idempotency-Key %s is a 400', async (_label, key) => {
    const result = await submit(api, wagerPayload(wallet), key);
    expect(result.status).toBe(400);
  });

  test('an Idempotency-Key of exactly 255 characters is accepted', async () => {
    const result = await submit(api, wagerPayload(wallet, { money: brl('1.00') }), 'k'.repeat(255));
    expect(result.status).toBe(200);
  });

  test.each([
    ['amount as a number', { money: { amount: 25, currency: 'BRL' } }],
    ['amount with one decimal place', { money: brl('25.5') }],
    ['amount in scientific notation', { money: brl('1e3') }],
    ['zero amount on a BET', { money: brl('0.00') }],
    ['OPENING kind', { kind: 'OPENING' }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['reserved provider', { providerId: 'internal' }],
    ['reserved provider in another case', { providerId: 'Internal' }],
    ['walletId not a UUID', { walletId: 'wallet-1' }],
    ['empty roundId', { roundId: '' }],
    ['unknown field', { bonus: true }],
    ['REFUND without reference', { kind: 'REFUND' }],
    ['BET with reference', { referenceExternalTransactionId: 'ext-1' }],
  ])('%s is a 400 and writes nothing', async (_label, overrides) => {
    const before = await footprint(wallet.id);
    const result = await submit(api, wagerPayload(wallet, overrides as Record<string, unknown>));
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_PAYLOAD');
    expect(await footprint(wallet.id)).toEqual(before);
  });

  test('malformed JSON is a 400 with the same error shape', async () => {
    const result = await api.post('/wagering/transactions', '{"kind": ', { 'idempotency-key': 'k-1' });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ code: 'INVALID_PAYLOAD', message: expect.any(String) });
  });
});

describe('temporary 501 for transactions with a reference (until slice 4b)', () => {
  test.each(['REFUND', 'ROLLBACK', 'WIN', 'LOSS'])('%s with referenceExternalTransactionId is a 501 and writes nothing', async (kind) => {
    const w = await createWalletViaApi(api, '100.00');
    const before = await footprint(w.id);
    const result = await submit(api, wagerPayload(w, { kind, referenceExternalTransactionId: 'ext-bet-1' }));
    expect(result.status).toBe(501);
    expect(result.body.code).toBe('REFERENCE_NOT_SUPPORTED_YET');
    expect(await footprint(w.id)).toEqual(before);
  });
});

describe('invariant', () => {
  test('every wallet balance equals the balance rebuilt from the ledger', async () => {
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });
});
