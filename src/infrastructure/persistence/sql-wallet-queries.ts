import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors';
import type {
  LedgerEntryView,
  ReconciliationSnapshot,
  WalletQueries,
  WalletView,
} from '../../application/ports/wallet-queries';
import { isTransientDatabaseError } from './database-errors';
import { parseTimestamp } from './timestamps';

type Row = Record<string, unknown>;

/*
 * Leituras em SQL explícito, sem transação de escrita e sem nenhum lock. Valores monetários saem como `::text`
 * (string decimal exata), nunca como number.
 */
export class SqlWalletQueries implements WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<WalletView | undefined> {
    const [row] = await this.query(
      `SELECT id, player_id, currency, balance::text AS balance, version FROM wallets WHERE id = ?`,
      [walletId],
    );
    if (row === undefined) return undefined;
    return {
      id: row.id as string,
      playerId: row.player_id as string,
      balance: { amount: row.balance as string, currency: row.currency as string },
      version: row.version as number,
    };
  }

  async listLedger(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[] | undefined> {
    // LEFT JOIN: uma só instrução distingue "wallet inexistente" (zero linhas) de "sem lançamentos" (uma linha
    // com l.id nulo). A wallet nunca é apagada, então não há corrida entre existência e leitura.
    const rows = await this.query(
      `SELECT w.currency, l.id, l.transaction_id, l.direction, l.wallet_version, l.amount::text AS amount,
              l.balance_before::text AS balance_before, l.balance_after::text AS balance_after, l.created_at
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id AND l.wallet_version > ?
       WHERE w.id = ?
       ORDER BY l.wallet_version
       LIMIT ?`,
      [afterVersion, walletId, limit],
    );
    if (rows.length === 0) return undefined;
    return rows
      .filter((row) => row.id !== null)
      .map((row) => {
        const currency = row.currency as string;
        return {
          id: row.id as string,
          transactionId: row.transaction_id as string,
          direction: row.direction as 'CREDIT' | 'DEBIT',
          walletVersion: row.wallet_version as number,
          money: { amount: row.amount as string, currency },
          balanceBefore: { amount: row.balance_before as string, currency },
          balanceAfter: { amount: row.balance_after as string, currency },
          createdAt: parseTimestamp(row.created_at).toISOString(),
        };
      });
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    // UMA instrução = UM snapshot (READ COMMITTED vale por instrução). Wallet e lançamento são gravados na mesma
    // transação, então o snapshot enxerga os dois ou nenhum dos dois: não há divergência falsa, e nenhum lock.
    // Soma, diferença e comparação são NUMERIC no Postgres; o JS só repassa strings.
    const [row] = await this.query(
      `SELECT w.currency, w.balance::text AS stored, l.calculated::text AS calculated,
              (w.balance - l.calculated)::text AS difference, (w.balance = l.calculated) AS consistent, l.entries
       FROM wallets w
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(19,2)
                  AS calculated,
                COUNT(*)::int AS entries
         FROM wallet_ledger_entries e WHERE e.wallet_id = w.id
       ) l
       WHERE w.id = ?`,
      [walletId],
    );
    if (row === undefined) return undefined;
    const currency = row.currency as string;
    return {
      storedBalance: { amount: row.stored as string, currency },
      calculatedBalance: { amount: row.calculated as string, currency },
      difference: { amount: row.difference as string, currency },
      consistent: row.consistent as boolean,
      checkedEntries: row.entries as number,
    };
  }

  private async query(sql: string, params: unknown[]): Promise<Row[]> {
    try {
      return await (this.orm.em.fork() as EntityManager).execute<Row[]>(sql, params);
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError('Database temporarily unavailable', { cause: error });
      }
      throw error;
    }
  }
}
