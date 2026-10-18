import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { encodeLedgerCursor } from '../../src/application/wallets/ledger-cursor';
import {
  createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload, type WalletBody,
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
  api = await startTestApp({ ledger: { defaultPageSize: 50, maxPageSize: 100 } });
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

interface LedgerBody {
  entries: Array<{
    id: string; transactionId: string; direction: string; walletVersion: number;
    money: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    createdAt: string;
  }>;
  nextCursor: string | null;
}

/** N apostas de 1.00 em sequência, cada uma gerando um lançamento (versões 2..N+1). */
async function placeBets(wallet: WalletBody, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const result = await submit(api, wagerPayload(wallet, { money: { amount: '1.00', currency: 'BRL' } }));
    expect(result.status).toBe(200);
  }
}

describe('GET /wallets/:walletId', () => {
  test('returns the wallet with the balance as {amount, currency}', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    await placeBets(wallet, 1);
    const result = await get(`/wallets/${wallet.id}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      id: wallet.id, playerId: wallet.playerId, balance: { amount: '99.00', currency: 'BRL' }, version: 2,
    });
  });

  test('unknown wallet is a 404 WALLET_NOT_FOUND', async () => {
    const result = await get<{ code: string }>(`/wallets/${Bun.randomUUIDv7()}`);
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('WALLET_NOT_FOUND');
  });

  test('a walletId that is not a UUID is a 400', async () => {
    const result = await get<{ code: string }>('/wallets/not-a-uuid');
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('an entry carries id, transactionId, direction, walletVersion, money, balances and an ISO createdAt', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    await placeBets(wallet, 1);
    const { status, body } = await get<LedgerBody>(`/wallets/${wallet.id}/ledger`);
    expect(status).toBe(200);
    expect(body.nextCursor).toBeNull();
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toEqual({
      id: expect.any(String), transactionId: expect.any(String), direction: 'CREDIT', walletVersion: 1,
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(body.entries[1]).toMatchObject({
      direction: 'DEBIT', walletVersion: 2, money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' }, balanceAfter: { amount: '99.00', currency: 'BRL' },
    });
  });

  test('a wallet without entries returns an empty page and a null cursor', async () => {
    const wallet = await createWalletViaApi(api, '0.00');
    const { status, body } = await get<LedgerBody>(`/wallets/${wallet.id}/ledger`);
    expect(status).toBe(200);
    expect(body).toEqual({ entries: [], nextCursor: null });
  });

  test('pages by cursor, in wallet_version order, and the last page has a null cursor', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    await placeBets(wallet, 4); // versões 1..5
    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`;
      const { body } = await get<LedgerBody>(`/wallets/${wallet.id}/ledger?${query}`);
      versions.push(...body.entries.map((e) => e.walletVersion));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
  });

  test('when the entries are an exact multiple of the limit, the last full page already has a null cursor', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    await placeBets(wallet, 3); // versões 1..4
    const first = await get<LedgerBody>(`/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.body.nextCursor).toBe(encodeLedgerCursor(2));
    const second = await get<LedgerBody>(`/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.entries.map((e) => e.walletVersion)).toEqual([3, 4]);
    expect(second.body.nextCursor).toBeNull();
  });

  test('without limit, the default page size applies', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const { body } = await get<LedgerBody>(`/wallets/${wallet.id}/ledger`);
    expect(body.entries).toHaveLength(1);
  });

  test('a stable pagination while writes happen concurrently: nothing repeated, nothing lost', async () => {
    const wallet = await createWalletViaApi(api, '1000.00');
    const writes = 60;
    let writing = true;
    // Apostas em paralelo, em lotes de 6, enquanto o leitor pagina com limit=4.
    const writer = (async () => {
      for (let batch = 0; batch < writes / 6; batch += 1) {
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            submit(api, wagerPayload(wallet, { money: { amount: '1.00', currency: 'BRL' } }))),
        );
        for (const result of results) expect(result.status).toBe(200);
      }
      writing = false;
    })();

    const seen: number[] = [];
    let lastVersion = 0;
    for (;;) {
      const wasWriting = writing;
      const query = lastVersion === 0 ? 'limit=4' : `limit=4&cursor=${encodeLedgerCursor(lastVersion)}`;
      const { body } = await get<LedgerBody>(`/wallets/${wallet.id}/ledger?${query}`);
      for (const entry of body.entries) {
        seen.push(entry.walletVersion);
        lastVersion = entry.walletVersion;
      }
      // Leu até o fim e o escritor já tinha terminado antes desta leitura: não há mais nada a ver.
      if (body.nextCursor === null && !wasWriting) break;
    }
    await writer;

    expect(seen).toEqual(Array.from({ length: writes + 1 }, (_, i) => i + 1));
    const [row] = await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id]);
    expect(row?.n).toBe(writes + 1);
  });

  test.each([
    ['garbage', 'abc!'],
    ['plain number', '5'],
    ['base64 padding', 'NQ=='],
    ['zero', Buffer.from('0').toString('base64url')],
    ['negative', Buffer.from('-3').toString('base64url')],
    ['overflow', Buffer.from('99999999999').toString('base64url')],
    ['version prefix', Buffer.from('v:2').toString('base64url')],
    ['empty', ''],
  ])('invalid cursor (%s) is a 400 INVALID_CURSOR', async (_name, cursor) => {
    const wallet = await createWalletViaApi(api, '10.00');
    const { status, body } = await get<{ code: string }>(`/wallets/${wallet.id}/ledger?cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_CURSOR');
  });

  test.each(['0', '-1', 'abc', '1.5', '101', '', '1e1', '%205'])('invalid limit (%p) is a 400 INVALID_LIMIT', async (limit) => {
    const wallet = await createWalletViaApi(api, '10.00');
    const { status, body } = await get<{ code: string }>(`/wallets/${wallet.id}/ledger?limit=${limit}`);
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_LIMIT');
  });

  test('the maximum limit itself is accepted', async () => {
    const wallet = await createWalletViaApi(api, '10.00');
    expect((await get(`/wallets/${wallet.id}/ledger?limit=100`)).status).toBe(200);
  });

  test('unknown wallet is a 404, even with a valid cursor', async () => {
    const id = Bun.randomUUIDv7();
    const result = await get<{ code: string }>(`/wallets/${id}/ledger?cursor=${encodeLedgerCursor(1)}`);
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('WALLET_NOT_FOUND');
  });
});
