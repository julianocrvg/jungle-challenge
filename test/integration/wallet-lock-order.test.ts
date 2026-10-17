import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import {
  createTestOrm, insertWallet, type Sql, sqlRunner, TEST_DATABASE_URL, type WalletFixture, walletsDivergingFromLedger,
} from './support/database';

/*
 * Ordem de locks do use case de submissão (ARCHITECTURE 5.1): travar a wallet com FOR UPDATE ANTES do
 * INSERT da wager_transaction. O INSERT valida a FK wallet_id e deixa um FOR KEY SHARE na linha da
 * wallet; FOR KEY SHARE não conflita com outro FOR KEY SHARE, mas conflita com FOR UPDATE. Se duas
 * transações inserem primeiro e travam depois, cada uma espera a outra soltar o KEY SHARE: 40P01.
 *
 * `submitBet` reproduz em SQL o protocolo do use case. Na fatia 4 o teste de carga passa a chamar
 * o use case real; o teste de controle (ordem errada) continua em SQL, porque documenta o motivo.
 */

let orm: MikroORM;
let sql: Sql;

beforeAll(async () => {
  await (await createTestOrm()).close(true);
  // Pool maior que o padrão para que as requisições disputem a wallet de fato em paralelo.
  orm = await MikroORM.init({ ...createOrmConfig(TEST_DATABASE_URL), pool: { min: 0, max: 30 } });
  sql = sqlRunner(orm);
});

afterAll(async () => {
  await orm?.close(true);
});

const DEADLOCK = '40P01';
// Folga para o detector de deadlock do Postgres (deadlock_timeout = 1s): se a ordem regredir, o teste
// falha mostrando os 40P01 em vez de estourar o timeout padrão de 5s.
const CONCURRENCY_TIMEOUT_MS = 60_000;

/** SQLSTATE do erro, venha ele cru do driver ou embrulhado pela exceção do MikroORM. */
function sqlStateOf(error: unknown): string | undefined {
  const e = error as { code?: unknown; sqlState?: unknown; cause?: { code?: unknown } };
  for (const candidate of [e?.code, e?.sqlState, e?.cause?.code]) {
    if (typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
  }
  return undefined;
}

type Outcome = 'PROCESSED' | 'REJECTED' | 'DUPLICATE';

function insertTxSql(): string {
  return `INSERT INTO wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, amount, currency, status, failure_code, balance_after, processed_at)
          VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'BET', ?, 'BRL', ?, ?, ?, now())
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id`;
}

/**
 * Protocolo do use case, na ordem correta: (1) FOR UPDATE na wallet, (2) INSERT ... ON CONFLICT DO
 * NOTHING da transação já com o resultado decidido sob o lock, (3) ledger e UPDATE com `version`.
 */
async function submitBet(wallet: WalletFixture, externalId: string, stake: Money): Promise<Outcome> {
  return orm.em.fork().transactional(async (em: EntityManager) => {
    const [row] = await em.execute(
      `SELECT balance::text AS balance, version FROM wallets WHERE id = ? FOR UPDATE`, [wallet.walletId],
    );
    const balance = Money.from({ amount: String(row!.balance), currency: 'BRL' });
    const version = row!.version as number;
    const fits = !balance.isLessThan(stake);
    const balanceAfter = fits ? balance.subtract(stake) : balance;

    const txId = Bun.randomUUIDv7();
    const inserted = await em.execute(insertTxSql(), [
      txId, externalId, `provider-a:${externalId}`, 'b'.repeat(64), wallet.walletId, wallet.playerId,
      stake.toJSON().amount, fits ? 'PROCESSED' : 'REJECTED', fits ? null : 'INSUFFICIENT_FUNDS',
      balanceAfter.toJSON().amount,
    ]);
    if (inserted.length === 0) return 'DUPLICATE';
    if (!fits) return 'REJECTED';

    await em.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
       VALUES (?, ?, ?, ?, 'DEBIT', ?, 'BRL', ?, ?)`,
      [Bun.randomUUIDv7(), wallet.walletId, txId, version + 1, stake.toJSON().amount,
        balance.toJSON().amount, balanceAfter.toJSON().amount],
    );
    const updated = await em.execute(
      `UPDATE wallets SET balance = ?, version = version + 1, updated_at = now()
       WHERE id = ? AND version = ? RETURNING id`,
      [balanceAfter.toJSON().amount, wallet.walletId, version],
    );
    if (updated.length !== 1) throw new Error('lost update: wallet version changed under the lock');
    return 'PROCESSED';
  });
}

/** Roda todas em paralelo e falha se QUALQUER uma lançar (deadlock, serialização, lost update...). */
async function runAll(tasks: (() => Promise<Outcome>)[]): Promise<Outcome[]> {
  const settled = await Promise.allSettled(tasks.map((task) => task()));
  const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []));
  expect(failures.map((f) => sqlStateOf(f) ?? String(f))).toEqual([]);
  return settled.map((s) => (s as PromiseFulfilledResult<Outcome>).value);
}

const count = (outcomes: Outcome[], wanted: Outcome) => outcomes.filter((o) => o === wanted).length;

async function walletState(walletId: string) {
  const [row] = await sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [walletId]);
  return row!;
}

/** Espera (polling com timeout, sem sleep fixo) até o backend `pid` estar bloqueado num lock. */
async function waitUntilBlockedOnLock(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ?`, [pid]);
    if (row?.wait_event_type === 'Lock') return;
    await Bun.sleep(10);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
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
      await waitUntilBlockedOnLock(pidA);
      await lockWallet(em);
    });

    const results = await Promise.allSettled([a, b]);
    const states = results.map((r) => (r.status === 'rejected' ? sqlStateOf(r.reason) : 'ok'));
    expect(states.filter((s) => s === DEADLOCK)).toHaveLength(1);
    expect(states.filter((s) => s === 'ok')).toHaveLength(1);
  });

  test('many concurrent bets on the same wallet: no deadlock, exactly the bets that fit are debited', async () => {
    const wallet = await insertWallet(sql, '30.00');
    const stake = Money.from({ amount: '1.00', currency: 'BRL' });

    const outcomes = await runAll(
      Array.from({ length: 60 }, (_, i) => () => submitBet(wallet, `ext-${i}-${Bun.randomUUIDv7()}`, stake)),
    );

    expect(count(outcomes, 'PROCESSED')).toBe(30);
    expect(count(outcomes, 'REJECTED')).toBe(30);
    expect(await walletState(wallet.walletId)).toEqual({ balance: '0.00', version: 31 });
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  }, CONCURRENCY_TIMEOUT_MS);

  test('the same bet sent many times concurrently: no deadlock, one debit, the rest are duplicates', async () => {
    const wallet = await insertWallet(sql, '100.00');
    const stake = Money.from({ amount: '80.00', currency: 'BRL' });
    const externalId = `ext-${Bun.randomUUIDv7()}`;

    const outcomes = await runAll(Array.from({ length: 50 }, () => () => submitBet(wallet, externalId, stake)));

    expect(count(outcomes, 'PROCESSED')).toBe(1);
    expect(count(outcomes, 'DUPLICATE')).toBe(49);
    expect(await walletState(wallet.walletId)).toEqual({ balance: '20.00', version: 2 });
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  }, CONCURRENCY_TIMEOUT_MS);
});
