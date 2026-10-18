import type { MoneyProps } from '../../domain/money';

/*
 * Modelos de leitura. Dinheiro sai do banco como string decimal e fica como `MoneyProps`: não passa pelo
 * domínio, porque uma consulta não aplica regra nenhuma (e a diferença da reconciliação pode ser negativa,
 * o que `Money.from` recusa).
 */

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: 'CREDIT' | 'DEBIT';
  walletVersion: number;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** ISO-8601. */
  createdAt: string;
}

export interface ReconciliationSnapshot {
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** `storedBalance − calculatedBalance`, calculada pelo Postgres em NUMERIC. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Leituras sem lock e fora da UnitOfWork de escrita (ARCHITECTURE 9.1). `undefined`: a wallet não existe. */
export interface WalletQueries {
  findWallet(walletId: string): Promise<WalletView | undefined>;
  /** Até `limit` lançamentos com `wallet_version > afterVersion`, em ordem crescente de versão. */
  listLedger(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[] | undefined>;
  /** Saldo guardado e soma do ledger lidos na MESMA instrução SQL, portanto no mesmo snapshot. */
  reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export const WALLET_QUERIES = Symbol('WalletQueries');
