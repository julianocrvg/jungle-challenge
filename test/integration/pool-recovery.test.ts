import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { createTestOrm, type Sql, sqlRunner, TEST_DATABASE_URL, walletsDivergingFromLedger } from './support/database';
import { waitFor } from './support/outbox';

/*
 * Uma conexão derrubada pelo servidor no meio de uma transação não pode vazar a vaga do pool (pool-guard.ts,
 * ARCHITECTURE 5.5). Com `poolMax: 1`, uma vaga perdida faz a transação seguinte esperar para sempre.
 */

let admin: MikroORM;
let sql: Sql;

beforeAll(async () => {
  admin = await createTestOrm();
  sql = sqlRunner(admin);
});

afterAll(async () => {
  await admin?.close(true);
});

/** Falha (em vez de travar o teste) se a promessa não terminar no prazo. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish in ${ms}ms (pool slot leaked?)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function singleConnectionUow(): Promise<{ orm: MikroORM; uow: MikroOrmUnitOfWork }> {
  const orm = await MikroORM.init(createOrmConfig(TEST_DATABASE_URL, { poolMax: 1 }));
  return { orm, uow: new MikroOrmUnitOfWork(orm, 10_000) };
}

describe('pool recovery after the server drops a connection mid-transaction', () => {
  test('idle_in_transaction_session_timeout: the next transaction gets a fresh connection and close() completes', async () => {
    const { orm, uow } = await singleConnectionUow();
    await expect(uow.run(async ({ outbox }) => {
      await outbox.oldestPendingOccurredAt();
      await Bun.sleep(600); // ocioso dentro da transação por mais que o timeout abaixo
      await outbox.oldestPendingOccurredAt();
    }, { idleInTransactionTimeoutMs: 150 })).rejects.toThrow();

    expect(await within(uow.run(async ({ outbox }) => (await outbox.oldestPendingOccurredAt()) ?? 'none'), 3_000, 'next run'))
      .toBe('none');
    await within(orm.close(true), 3_000, 'orm.close');
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });

  test('pg_terminate_backend (as in a database restart): same recovery', async () => {
    const { orm, uow } = await singleConnectionUow();
    let backendPid: unknown;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const victim = uow.run(async ({ outbox }) => {
      await outbox.oldestPendingOccurredAt();
      const [row] = await sql(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
      backendPid = row?.pid;
      entered();
      await waitFor(async () => backendPid === 'terminated', (done) => done, 5_000);
      await outbox.oldestPendingOccurredAt();
    });
    await inside;
    expect(backendPid).toBeDefined();
    await sql(`SELECT pg_terminate_backend(?)`, [backendPid]);
    backendPid = 'terminated';
    await expect(victim).rejects.toThrow();

    expect(await within(uow.run(async () => 'ok'), 3_000, 'next run')).toBe('ok');
    await within(orm.close(true), 3_000, 'orm.close');
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });
});
