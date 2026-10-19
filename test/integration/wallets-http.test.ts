import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { createWalletViaApi, startTestApp, type TestApp, type WalletBody } from './support/app';

import { monetaryLeaks } from './support/logs';

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

beforeEach(() => api.logger.clear());

// Nenhum log do HTTP traz valor monetário (ARCHITECTURE 11.2).
afterEach(() => {
  expect(monetaryLeaks(api.logger.entries)).toEqual([]);
});

describe('POST /wallets', () => {
  test('with an initial balance: version 1, OPENING PROCESSED, CREDIT at wallet_version 1 and an outbox event', async () => {
    const wallet = await createWalletViaApi(api, '1000.00');
    expect(wallet).toEqual({
      id: expect.any(String), playerId: expect.any(String), balance: { amount: '1000.00', currency: 'BRL' }, version: 1,
    });

    const [row] = await sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [wallet.id]);
    expect(row).toEqual({ balance: '1000.00', version: 1 });

    const transactions = await sql(
      `SELECT provider_id, external_transaction_id, idempotency_key, kind, status, amount::text AS amount,
              balance_after::text AS balance_after, round_id, game_id, length(payload_hash) AS hash_length
       FROM wager_transactions WHERE wallet_id = ?`,
      [wallet.id],
    );
    expect(transactions).toEqual([{
      provider_id: 'internal', external_transaction_id: `opening:${wallet.id}`,
      idempotency_key: `internal:opening:${wallet.id}`, kind: 'OPENING', status: 'PROCESSED', amount: '1000.00',
      balance_after: '1000.00', round_id: null, game_id: null, hash_length: 64,
    }]);

    const ledger = await sql(
      `SELECT wallet_version, direction, amount::text AS amount, balance_before::text AS balance_before
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [wallet.id],
    );
    expect(ledger).toEqual([{ wallet_version: 1, direction: 'CREDIT', amount: '1000.00', balance_before: '0.00' }]);

    const outbox = await sql(`SELECT event_type, payload FROM outbox WHERE aggregate_id = ?`, [wallet.id]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.event_type).toBe('WalletBalanceChanged');
    expect((outbox[0]?.payload as { data: { walletVersion: number } }).data.walletVersion).toBe(1);
  });

  test('with a zero balance: version 1, no transaction, no ledger entry, no event', async () => {
    const wallet = await createWalletViaApi(api, '0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    const [counts] = await sql(
      `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = ?)::int AS txs,
              (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::int AS entries,
              (SELECT count(*) FROM outbox WHERE aggregate_id = ?)::int AS events`,
      [wallet.id, wallet.id, wallet.id],
    );
    expect(counts).toEqual({ txs: 0, entries: 0, events: 0 });
  });

  test('a duplicate wallet for the same player and currency is a 409, and nothing extra is written', async () => {
    const first = await createWalletViaApi(api, '10.00');
    const again = await api.post('/wallets', { playerId: first.playerId, initialBalance: { amount: '50.00', currency: 'BRL' } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WALLET_ALREADY_EXISTS');
    const [row] = await sql(`SELECT count(*)::int AS n FROM wallets WHERE player_id = ?`, [first.playerId]);
    expect(row?.n).toBe(1);
  });

  test('the same player may open a wallet in another currency', async () => {
    const brl = await createWalletViaApi(api, '10.00');
    const usd = await api.post<WalletBody>('/wallets', {
      playerId: brl.playerId, initialBalance: { amount: '5.00', currency: 'USD' },
    });
    expect(usd.status).toBe(201);
    expect(usd.body.balance).toEqual({ amount: '5.00', currency: 'USD' });
  });

  test('concurrent creation of the same wallet: exactly one 201, the rest 409', async () => {
    const playerId = Bun.randomUUIDv7();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        api.post('/wallets', { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  test.each([
    ['amount as a number', { amount: 100, currency: 'BRL' }],
    ['one decimal place', { amount: '100.0', currency: 'BRL' }],
    ['scientific notation', { amount: '1e3', currency: 'BRL' }],
    ['negative amount', { amount: '-1.00', currency: 'BRL' }],
    ['lowercase currency', { amount: '1.00', currency: 'brl' }],
  ])('invalid initial balance (%s) is a 400', async (_label, initialBalance) => {
    const result = await api.post('/wallets', { playerId: Bun.randomUUIDv7(), initialBalance });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_PAYLOAD');
  });

  test('invalid playerId and unknown fields are a 400 listing every problem', async () => {
    const result = await api.post<{ code: string; details: string[] }>('/wallets', {
      playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' }, version: 7,
    });
    expect(result.status).toBe(400);
    expect(result.body.details).toEqual(['version is not allowed', 'playerId must be a UUID']);
  });

  test('every wallet balance equals the balance rebuilt from the ledger', async () => {
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });
});
