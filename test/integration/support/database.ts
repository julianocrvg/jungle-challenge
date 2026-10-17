import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering_test';

/** Sobe o ORM no banco de teste com o schema recriado do zero (down até o início, depois up). */
export async function createTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(createOrmConfig(TEST_DATABASE_URL));
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
  return orm;
}

export type Sql = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export function sqlRunner(orm: MikroORM): Sql {
  return (sql, params = []) => orm.em.getConnection().execute(sql, params, 'all');
}

export interface WalletFixture {
  walletId: string;
  playerId: string;
  openingTxId: string | null;
}

/**
 * Cria wallet como o domínio a abre (`Wallet.open` / `openWithBalance`): version 1 e, se o saldo
 * inicial for > 0, a transação OPENING PROCESSED e o lançamento CREDIT em wallet_version 1.
 */
export async function insertWallet(sql: Sql, balance = '100.00', currency = 'BRL'): Promise<WalletFixture> {
  const walletId = Bun.randomUUIDv7();
  const playerId = Bun.randomUUIDv7();
  await sql(`INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (?, ?, ?, ?, 1)`, [
    walletId, playerId, currency, balance,
  ]);
  if (balance === '0.00') return { walletId, playerId, openingTxId: null };

  const openingTxId = Bun.randomUUIDv7();
  await sql(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        kind, amount, currency, status, balance_after, processed_at)
     VALUES (?, 'internal', ?, ?, ?, ?, ?, 'OPENING', ?, ?, 'PROCESSED', ?, now())`,
    [openingTxId, `opening:${walletId}`, `internal:opening:${walletId}`, 'a'.repeat(64), walletId, playerId,
      balance, currency, balance],
  );
  await sql(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
     VALUES (?, ?, ?, 1, 'CREDIT', ?, ?, '0.00', ?)`,
    [Bun.randomUUIDv7(), walletId, openingTxId, balance, currency, balance],
  );
  return { walletId, playerId, openingTxId };
}

/**
 * Invariante final de todos os testes de integração: o saldo materializado de cada wallet
 * é igual ao saldo reconstruído pelo ledger. Devolve as wallets divergentes (esperado: nenhuma).
 */
export async function walletsDivergingFromLedger(sql: Sql): Promise<Record<string, unknown>[]> {
  return sql(`
    SELECT w.id, w.balance::text AS stored, COALESCE(l.calculated, 0)::text AS calculated
    FROM wallets w
    LEFT JOIN (
      SELECT wallet_id,
             SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS calculated
      FROM wallet_ledger_entries
      GROUP BY wallet_id
    ) l ON l.wallet_id = w.id
    WHERE w.balance <> COALESCE(l.calculated, 0)`);
}
