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
