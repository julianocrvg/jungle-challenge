import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { sqlStateOf } from '../../src/infrastructure/persistence/database-errors';
import {
  createTestOrm, insertWallet, type Sql, sqlRunner, TEST_DATABASE_URL, walletsDivergingFromLedger,
} from './support/database';
import {
  createWalletViaApi, type HttpResult, startTestApp, submit, type TestApp, type SubmissionBody, wagerPayload,
} from './support/app';

/*
 * Concorrência na mesma wallet (ARCHITECTURE 5.1 e 5.5). O use case trava a wallet com FOR UPDATE ANTES
 * do INSERT da wager_transaction: o INSERT valida a FK wallet_id e deixa um FOR KEY SHARE na linha, que
 * não conflita com outro FOR KEY SHARE mas conflita com FOR UPDATE. Inserir primeiro e travar depois
 * leva duas requisições a esperar uma pela outra: 40P01.
 *
 * O teste de controle (ordem errada) fica em SQL, porque documenta o motivo. Os demais passam pela API.
 */

let orm: MikroORM;
let sql: Sql;
let api: TestApp;

beforeAll(async () => {
  await (await createTestOrm()).close(true);
  // ORM do próprio teste: segura locks em transações externas e consulta pg_stat_activity.
  orm = await MikroORM.init({ ...createOrmConfig(TEST_DATABASE_URL), pool: { min: 0, max: 10 } });
  sql = sqlRunner(orm);
  api = await startTestApp();
});

afterAll(async () => {
  await api?.close();
  await orm?.close(true);
});

const DEADLOCK = '40P01';
// Folga para o detector de deadlock do Postgres (deadlock_timeout = 1s): se a ordem regredir, o teste
// falha mostrando os erros em vez de estourar o timeout.
const CONCURRENCY_TIMEOUT_MS = 60_000;

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function walletState(walletId: string) {
  const [row] = await sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [walletId]);
  return row!;
}

async function ledgerCount(walletId: string): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]);
  return row!.n as number;
}

const statusesOf = (results: HttpResult<SubmissionBody>[]) => results.map((r) => r.status);
const countStatus = (results: HttpResult<SubmissionBody>[], status: number) =>
  results.filter((r) => r.status === status).length;

/** Nenhum 5xx e nenhum log de deadlock ou de lock_timeout durante o teste. */
function expectNoInfrastructureFailures(results: HttpResult<SubmissionBody>[], logsBefore: number): void {
  expect(statusesOf(results).filter((s) => s >= 500)).toEqual([]);
  const logged = api.logger.entries.slice(logsBefore).filter((e) => e.level === 'error' || e.level === 'warn');
  expect(logged.filter((e) => e.message.includes(DEADLOCK) || e.message.includes('55P03'))).toEqual([]);
  expect(logged).toEqual([]);
}

/** Backends bloqueados esperando um lock de linha num SELECT ... FOR UPDATE. */
async function backendsWaitingForWalletLock(): Promise<number> {
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'
       AND pid <> pg_backend_pid()`,
  );
  return row!.n as number;
}

/** Polling com timeout, sem sleep fixo. */
async function waitFor(condition: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Abre uma transação externa que segura o FOR UPDATE da wallet até `release()`. */
async function holdWalletLock(walletId: string): Promise<{ release: () => Promise<void> }> {
  const { promise: locked, resolve: signalLocked } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const transaction = orm.em.fork().transactional(async (em: EntityManager) => {
    await em.execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [walletId]);
    signalLocked();
    await released;
  });
  await locked;
  return {
    release: async () => {
      release();
      await transaction;
    },
  };
}

describe('lock order: wallet FOR UPDATE before inserting the transaction', () => {
  test('control: inserting the transaction first and locking after deadlocks (40P01)', async () => {
    const wallet = await insertWallet(sql, '100.00');
    const lockWallet = (em: EntityManager) =>
      em.execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [wallet.walletId]);
    const insertPending = (em: EntityManager) => {
      const externalId = `ext-${Bun.randomUUIDv7()}`;
      return em.execute(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status)
         VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', '10.00', 'BRL', 'PENDING')`,
        [Bun.randomUUIDv7(), externalId, `provider-a:${externalId}`, 'b'.repeat(64), wallet.walletId, wallet.playerId],
      );
    };

    // Intercala as duas transações de forma determinística: ambas inserem (FOR KEY SHARE pela FK),
    // A pede FOR UPDATE e bloqueia, depois B pede FOR UPDATE e fecha o ciclo.
    const { promise: aInserted, resolve: signalAInserted } = Promise.withResolvers<number>();
    const { promise: bInserted, resolve: signalBInserted } = Promise.withResolvers<void>();

    const a = orm.em.fork().transactional(async (em: EntityManager) => {
      const [{ pid }] = (await em.execute(`SELECT pg_backend_pid() AS pid`)) as [{ pid: number }];
      await insertPending(em);
      signalAInserted(pid);
      await bInserted;
      await lockWallet(em);
    });
    const b = orm.em.fork().transactional(async (em: EntityManager) => {
      const pidA = await aInserted;
      await insertPending(em);
      signalBInserted();
      await waitFor(async () => {
        const [row] = await sql(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ?`, [pidA]);
        return row?.wait_event_type === 'Lock';
      }, 'backend A to block on the wallet lock');
      await lockWallet(em);
    });

    const results = await Promise.allSettled([a, b]);
    const states = results.map((r) => (r.status === 'rejected' ? sqlStateOf(r.reason) : 'ok'));
    expect(states.filter((s) => s === DEADLOCK)).toHaveLength(1);
    expect(states.filter((s) => s === 'ok')).toHaveLength(1);
  });

  test('sanity: requests wait behind a held wallet lock and complete once it is released', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const lock = await holdWalletLock(wallet.id);

    let settled = 0;
    const requests = [
      submit(api, wagerPayload(wallet, { money: brl('10.00') })),
      submit(api, wagerPayload(wallet, { money: brl('20.00') })),
    ].map((p) => p.finally(() => { settled += 1; }));

    await waitFor(async () => (await backendsWaitingForWalletLock()) === 2, 'both requests to block on the lock');
    expect(settled).toBe(0);
    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });

    await lock.release();
    const results = await Promise.all(requests);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(await walletState(wallet.id)).toEqual({ balance: '70.00', version: 3 });
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });
});

describe('concurrent submissions on the same wallet', () => {
  test('mandatory scenario: two bets of 80.00 over 100.00 at once, one PROCESSED, one REJECTED, balance 20.00', async () => {
    // Repetido em várias wallets para que uma intercalação rara apareça.
    for (let round = 0; round < 10; round++) {
      const wallet = await createWalletViaApi(api, '100.00');
      const results = await Promise.all([
        submit(api, wagerPayload(wallet, { money: brl('80.00') })),
        submit(api, wagerPayload(wallet, { money: brl('80.00') })),
      ]);

      expect(statusesOf(results).sort()).toEqual([200, 422]);
      const processed = results.find((r) => r.status === 200)!.body;
      const rejected = results.find((r) => r.status === 422)!.body;
      expect(processed).toMatchObject({ status: 'PROCESSED', failureCode: null, balance: brl('20.00') });
      expect(rejected).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('20.00') });
      expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2 });
      // OPENING + um único débito.
      expect(await ledgerCount(wallet.id)).toBe(2);
    }
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  }, CONCURRENCY_TIMEOUT_MS);

  test('50 distinct bets at once: zero 503, zero 40P01, exactly the bets that fit are debited', async () => {
    const wallet = await createWalletViaApi(api, '30.00');
    const logsBefore = api.logger.entries.length;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(api, wagerPayload(wallet, { money: brl('1.00') }))),
    );

    expectNoInfrastructureFailures(results, logsBefore);
    expect(countStatus(results, 200)).toBe(30);
    expect(countStatus(results, 422)).toBe(20);
    expect(await walletState(wallet.id)).toEqual({ balance: '0.00', version: 31 });
    expect(await ledgerCount(wallet.id)).toBe(31);
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  }, CONCURRENCY_TIMEOUT_MS);

  test('the same bet 50 times at once: one debit, 49 replays of the same response, zero 503', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(wallet, { money: brl('80.00') });
    const logsBefore = api.logger.entries.length;

    const results = await Promise.all(Array.from({ length: 50 }, () => submit(api, payload)));

    expectNoInfrastructureFailures(results, logsBefore);
    expect(countStatus(results, 200)).toBe(50);
    const originals = results.filter((r) => !r.body.idempotentReplay);
    expect(originals).toHaveLength(1);
    for (const result of results) {
      expect(result.body).toEqual({ ...originals[0]!.body, idempotentReplay: result.body.idempotentReplay });
    }
    expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2 });
    expect(await ledgerCount(wallet.id)).toBe(2);
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  }, CONCURRENCY_TIMEOUT_MS);
});

describe('lock_timeout', () => {
  test('a lock held past lock_timeout is a 503 with Retry-After, writes nothing, and the retry succeeds', async () => {
    const impatient = await startTestApp({ database: { lockTimeoutMs: 200 } });
    try {
      const wallet = await createWalletViaApi(impatient, '100.00');
      const payload = wagerPayload(wallet, { money: brl('10.00') });
      const lock = await holdWalletLock(wallet.id);

      const blocked = await submit(impatient, payload);
      await lock.release();

      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('retry-after')).toBe('1');
      expect(blocked.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: expect.any(String) });
      expect(impatient.logger.entries.some((e) => e.level === 'warn' && e.message.includes('55P03'))).toBe(true);
      expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 1 });

      // Reenviar a mesma requisição é seguro: é processada uma única vez.
      const retry = await submit(impatient, payload);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: brl('90.00') });
      expect(await walletsDivergingFromLedger(sql)).toEqual([]);
    } finally {
      await impatient.close();
    }
  }, CONCURRENCY_TIMEOUT_MS);
});
