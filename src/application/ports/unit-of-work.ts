import type { InboxMessage } from '../../domain/inbox-message';
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
  /**
   * Ids das PENDING_REFERENCE com `next_attempt_at <= now`, as mais antigas primeiro. SEM lock (nem FOR UPDATE
   * nem SKIP LOCKED): travar a transação antes da wallet inverteria a ordem de locks (ARCHITECTURE 5.11 e 8.1).
   */
  listDuePendingReferences(now: Date, limit: number): Promise<string[]>;
  /** Quantas estão em PENDING_REFERENCE e o `created_at` da mais antiga (métricas do worker). */
  pendingReferenceStats(): Promise<{ pending: number; oldestCreatedAt: Date | undefined }>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  append(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * `published_at IS NULL AND next_attempt_at <= now ... FOR UPDATE SKIP LOCKED`: trava até `limit` mensagens
   * vencidas que nenhum outro publisher travou. `now` vem do Clock da aplicação, o mesmo que gravou as datas.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Grava `published_at`. Só sob o lock de `claimDue`; lança se a linha já estava publicada. */
  markPublished(message: OutboxMessage): Promise<void>;
  /** Grava `attempts` e `next_attempt_at`. Só sob o lock de `claimDue`; lança se a linha já estava publicada. */
  saveRetry(message: OutboxMessage): Promise<void>;
  /** `occurred_at` do evento pendente mais antigo (base da métrica de outbox lag). */
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

export interface InboxRepository {
  /**
   * `INSERT ... ON CONFLICT ON CONSTRAINT inbox_pk DO NOTHING`. `false`: (consumerName, messageId) já existe.
   * Uma entrega concorrente da mesma mensagem espera o commit da primeira e então vê o conflito, sem 23505.
   */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/**
 * Uma transação SQL. Tudo o que `work` grava é confirmado junto ou desfeito junto. Falhas transitórias de
 * infraestrutura saem como TransientInfrastructureError.
 */
export interface TransactionOptions {
  /**
   * `SET LOCAL idle_in_transaction_session_timeout`: para transações que esperam I/O externo com a sessão
   * aberta (publisher da outbox, ARCHITECTURE 6.2). Se o processo travar, o Postgres derruba a sessão.
   */
  idleInTransactionTimeoutMs?: number;
}

export interface UnitOfWork {
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
