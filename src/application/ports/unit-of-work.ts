import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** `SELECT ... FOR UPDATE`: trava a linha até o fim da transação. `undefined` se não existe. */
  lockById(walletId: string): Promise<Wallet | undefined>;
  /** `INSERT ... ON CONFLICT (player_id, currency) DO NOTHING`. `false`: a wallet já existe. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  /** `UPDATE ... WHERE version = expectedVersion`. Lança se a versão não casar (defesa extra ao lock). */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  /**
   * `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. `false`: a key já existe. Uma violação de
   * `wt_provider_external_uq` lança ExternalTransactionIdConflictError; qualquer outra sobe como está.
   */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  /** Leitura simples, sem lock. Quem decide com base no status precisa ter travado a wallet antes. */
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Resolução de referência: `(provider_id, external_transaction_id)`, sem lock (ARCHITECTURE 5.10). */
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND ou ROLLBACK PROCESSED desta referência? Só é confiável sob o lock da wallet. */
  existsProcessedReversalOf(referenceTransactionId: string): Promise<boolean>;
  /**
   * `UPDATE ... WHERE id = ? AND status = 'PENDING_REFERENCE'`, com o estado atual de `tx`. Só pode ser chamado
   * sob o lock da wallet; lança se o número de linhas afetadas não for 1 (bug: a linha já foi relida sob o lock).
   */
  updatePendingReference(tx: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  append(messages: readonly OutboxMessage[]): Promise<void>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
}

/**
 * Uma transação SQL. Tudo o que `work` grava é confirmado junto ou desfeito junto. Falhas transitórias de
 * infraestrutura saem como TransientInfrastructureError.
 */
export interface UnitOfWork {
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
