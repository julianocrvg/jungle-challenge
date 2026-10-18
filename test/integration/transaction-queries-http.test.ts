import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createWalletViaApi, startTestApp, submit, type TestApp, type TransactionBody, wagerPayload,
} from './support/app';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
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

beforeEach(() => api.logger.clear());

afterEach(() => {
  expect(monetaryLeaks(api.logger.entries)).toEqual([]);
});

afterAll(async () => {
  // Invariante final: wallets.balance == saldo reconstruído pelo ledger, em todas as wallets do arquivo.
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  await api?.close();
  await closeOrm?.();
});

async function get<T = Record<string, unknown>>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${api.baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

const byProvider = (providerId: string, externalId: string) =>
  `/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalId)}`;

describe('GET /wagering/transactions/:transactionId', () => {
  test('PROCESSED: 200 with the status, the observed balance and idempotentReplay false', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const placed = await submit(api, wagerPayload(wallet));
    expect(placed.status).toBe(200);

    const result = await get<TransactionBody>(`/wagering/transactions/${placed.body.transactionId}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      transactionId: placed.body.transactionId, status: 'PROCESSED', failureCode: null,
      balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false,
    });
  });

  test('REJECTED: still 200 (the query succeeded), with the status and the failureCode in the body', async () => {
    const wallet = await createWalletViaApi(api, '10.00');
    const placed = await submit(api, wagerPayload(wallet));
    expect(placed.status).toBe(422); // a submissão mantém o 422

    const result = await get<TransactionBody>(`/wagering/transactions/${placed.body.transactionId}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      transactionId: placed.body.transactionId, status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' }, idempotentReplay: false,
    });
  });

  test('PENDING_REFERENCE: still 200, with a null balance', async () => {
    const wallet = await createWalletViaApi(api, '10.00');
    const placed = await submit(api, wagerPayload(wallet, {
      kind: 'REFUND', referenceExternalTransactionId: 'bet-that-never-came',
    }));
    expect(placed.status).toBe(202); // a submissão mantém o 202

    const result = await get<TransactionBody>(`/wagering/transactions/${placed.body.transactionId}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      transactionId: placed.body.transactionId, status: 'PENDING_REFERENCE', failureCode: null,
      balance: null, idempotentReplay: false,
    });
  });

  test('unknown id is a 404 TRANSACTION_NOT_FOUND and nothing is persisted', async () => {
    const [before] = await sql(`SELECT count(*)::int AS n FROM wager_transactions`);
    const result = await get<{ code: string }>(`/wagering/transactions/${Bun.randomUUIDv7()}`);
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('TRANSACTION_NOT_FOUND');
    const [after] = await sql(`SELECT count(*)::int AS n FROM wager_transactions`);
    expect(after).toEqual(before);
  });

  test('an id that is not a UUID is a 400', async () => {
    const result = await get<{ code: string }>('/wagering/transactions/nope');
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_PAYLOAD');
  });

  test('the internal OPENING transaction is not visible through the API', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const [row] = await sql(`SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'`, [wallet.id]);
    const result = await get<{ code: string }>(`/wagering/transactions/${row?.id}`);
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

describe('GET /providers/:providerId/wagering/transactions/:externalTransactionId', () => {
  test('returns the same body as the lookup by id', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(wallet);
    const placed = await submit(api, payload);

    const viaProvider = await get<TransactionBody>(byProvider('provider-a', payload.externalTransactionId as string));
    const viaId = await get<TransactionBody>(`/wagering/transactions/${placed.body.transactionId}`);
    expect(viaProvider.status).toBe(200);
    expect(viaProvider.body).toEqual(viaId.body);
  });

  test('REJECTED and PENDING_REFERENCE are 200 here too', async () => {
    const wallet = await createWalletViaApi(api, '10.00');
    const rejected = wagerPayload(wallet);
    await submit(api, rejected);
    const pending = wagerPayload(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'missing-bet' });
    await submit(api, pending);

    const r = await get<TransactionBody>(byProvider('provider-a', rejected.externalTransactionId as string));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    const p = await get<TransactionBody>(byProvider('provider-a', pending.externalTransactionId as string));
    expect(p.status).toBe(200);
    expect(p.body.status).toBe('PENDING_REFERENCE');
  });

  test('an externalTransactionId and a providerId with special characters round-trip through the route', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const providerId = 'prov/ider x';
    const externalTransactionId = 'ext/with space:colon+plus%percent?query#hash é';
    const payload = wagerPayload(wallet, { providerId, externalTransactionId });
    // A key padrão teria espaço e "é", que o header recusa: usa uma key ASCII própria.
    const placed = await submit(api, payload, `special-${Bun.randomUUIDv7()}`);
    expect(placed.status).toBe(200);

    const result = await get<TransactionBody>(byProvider(providerId, externalTransactionId));
    expect(result.status).toBe(200);
    expect(result.body.transactionId).toBe(placed.body.transactionId!);
  });

  test('the same externalTransactionId under another provider is another transaction (404)', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(wallet);
    await submit(api, payload);
    const result = await get<{ code: string }>(byProvider('provider-b', payload.externalTransactionId as string));
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('TRANSACTION_NOT_FOUND');
  });

  test('the reserved provider never exposes the OPENING transaction', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const result = await get<{ code: string }>(byProvider('internal', `opening:${wallet.id}`));
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('TRANSACTION_NOT_FOUND');
  });
});
