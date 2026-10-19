import type { EntityManager } from '@mikro-orm/postgresql';
import { ExternalTransactionIdConflictError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/unit-of-work';
import { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  type FailureCode,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { uniqueViolationConstraint } from './database-errors';
import { parseOptionalTimestamp, parseTimestamp } from './timestamps';

/*
 * Repositórios em SQL explícito (ARCHITECTURE 1.2): cada lock e cada ON CONFLICT fica visível aqui.
 * Valores monetários entram e saem como string (`::text`), nunca como number.
 */

type Row = Record<string, unknown>;

const str = (row: Row, column: string): string => row[column] as string;
const optional = (row: Row, column: string): string | undefined => (row[column] ?? undefined) as string | undefined;
const date = (row: Row, column: string): Date => parseTimestamp(row[column]);
const optionalDate = (row: Row, column: string): Date | undefined => parseOptionalTimestamp(row[column]);

class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const [row] = await this.em.execute<Row[]>(
      `SELECT id, player_id, currency, balance::text AS balance, version, created_at, updated_at
       FROM wallets WHERE id = ? FOR UPDATE`,
      [walletId],
    );
    if (row === undefined) return undefined;
    return Wallet.rehydrate({
      id: str(row, 'id'),
      playerId: str(row, 'player_id'),
      currency: str(row, 'currency'),
      balance: Money.from({ amount: str(row, 'balance'), currency: str(row, 'currency') }),
      version: row.version as number,
      createdAt: date(row, 'created_at'),
      updatedAt: date(row, 'updated_at'),
    });
  }

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const rows = await this.em.execute<Row[]>(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (player_id, currency) DO NOTHING
       RETURNING id`,
      [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toJSON().amount, wallet.version,
        wallet.createdAt, wallet.updatedAt],
    );
    return rows.length === 1;
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await this.em.execute<Row[]>(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?
       RETURNING id`,
      [wallet.balance.toJSON().amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length !== 1) {
      // Com o FOR UPDATE isso não acontece; se acontecer é bug, e a transação inteira é desfeita.
      throw new Error(`Lost update on wallet ${wallet.id}: version ${expectedVersion} is no longer current`);
    }
  }
}

class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    try {
      const rows = await this.em.execute<Row[]>(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
            status, failure_code, balance_after, attempts, next_attempt_at, created_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId,
          tx.roundId ?? null, tx.gameId ?? null, tx.kind, tx.money.toJSON().amount, tx.money.currency,
          tx.referenceExternalTransactionId ?? null, tx.referenceTransactionId ?? null,
          tx.status, tx.failureCode ?? null, tx.balanceAfter?.toJSON().amount ?? null, tx.attempts,
          tx.nextAttemptAt ?? null, tx.createdAt, tx.processedAt ?? null,
        ],
      );
      return rows.length === 1;
    } catch (error) {
      // Só esta constraint é um conflito esperado; as demais indicam bug e sobem como estão (500).
      if (uniqueViolationConstraint(error) === 'wt_provider_external_uq') {
        throw new ExternalTransactionIdConflictError(
          'externalTransactionId was already submitted by this provider with another Idempotency-Key',
          { cause: error },
        );
      }
      throw error;
    }
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne('t.idempotency_key = ?', [idempotencyKey]);
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne('t.id = ?', [id]);
  }

  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne('t.provider_id = ? AND t.external_transaction_id = ?', [providerId, externalTransactionId]);
  }

  async existsProcessedReversalOf(referenceTransactionId: string): Promise<boolean> {
    // Mesmo predicado do índice wt_single_reversal_uq: a checagem e a rede de proteção falam da mesma coisa.
    const rows = await this.em.execute<Row[]>(
      `SELECT 1 FROM wager_transactions
       WHERE reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'
       LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async updatePendingReference(tx: WagerTransaction): Promise<void> {
    // O filtro por status é a guarda: só uma transição sai de PENDING_REFERENCE. Com a linha relida sob o
    // lock da wallet, zero linhas aqui é bug, e a transação inteira é desfeita.
    const rows = await this.em.execute<Row[]>(
      `UPDATE wager_transactions
       SET status = ?, failure_code = ?, balance_after = ?, reference_transaction_id = ?, attempts = ?,
           next_attempt_at = ?, processed_at = ?
       WHERE id = ? AND status = 'PENDING_REFERENCE'
       RETURNING id`,
      [tx.status, tx.failureCode ?? null, tx.balanceAfter?.toJSON().amount ?? null, tx.referenceTransactionId ?? null,
        tx.attempts, tx.nextAttemptAt ?? null, tx.processedAt ?? null, tx.id],
    );
    if (rows.length !== 1) {
      throw new Error(`Transaction ${tx.id} was no longer PENDING_REFERENCE under the wallet lock`);
    }
  }

  async listDuePendingReferences(now: Date, limit: number): Promise<string[]> {
    // Sem lock: dois workers podem listar a mesma linha, e quem decide é a releitura sob o lock da wallet
    // (ARCHITECTURE 8.1). A busca usa o índice parcial wt_pending_reference_due_idx.
    const rows = await this.em.execute<Row[]>(
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id
       LIMIT ?`,
      [now, limit],
    );
    return rows.map((row) => str(row, 'id'));
  }

  async pendingReferenceStats(): Promise<{ pending: number; oldestCreatedAt: Date | undefined }> {
    const [row] = await this.em.execute<Row[]>(
      `SELECT count(*)::int AS pending, min(created_at) AS oldest
       FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
    );
    return { pending: (row?.pending as number) ?? 0, oldestCreatedAt: row === undefined ? undefined : optionalDate(row, 'oldest') };
  }

  private async findOne(where: string, params: unknown[]): Promise<WagerTransaction | undefined> {
    // O saldo observado está na moeda da wallet (ARCHITECTURE 5.8), por isso o JOIN.
    const [row] = await this.em.execute<Row[]>(
      `SELECT t.id, t.provider_id, t.external_transaction_id, t.idempotency_key, t.payload_hash, t.wallet_id,
              t.player_id, t.round_id, t.game_id, t.kind, t.amount::text AS amount, t.currency,
              t.reference_external_transaction_id, t.reference_transaction_id, t.status, t.failure_code,
              t.balance_after::text AS balance_after, t.attempts, t.next_attempt_at, t.created_at, t.processed_at,
              w.currency AS wallet_currency
       FROM wager_transactions t JOIN wallets w ON w.id = t.wallet_id
       WHERE ${where}`,
      params,
    );
    if (row === undefined) return undefined;
    const balanceAfter = optional(row, 'balance_after');
    return WagerTransaction.rehydrate({
      id: str(row, 'id'),
      providerId: str(row, 'provider_id'),
      externalTransactionId: str(row, 'external_transaction_id'),
      idempotencyKey: str(row, 'idempotency_key'),
      payloadHash: str(row, 'payload_hash'),
      walletId: str(row, 'wallet_id'),
      playerId: str(row, 'player_id'),
      roundId: optional(row, 'round_id'),
      gameId: optional(row, 'game_id'),
      kind: str(row, 'kind') as WagerTransactionKind,
      money: Money.from({ amount: str(row, 'amount'), currency: str(row, 'currency') }),
      referenceExternalTransactionId: optional(row, 'reference_external_transaction_id'),
      createdAt: date(row, 'created_at'),
      status: str(row, 'status') as WagerTransactionStatus,
      referenceTransactionId: optional(row, 'reference_transaction_id'),
      failureCode: optional(row, 'failure_code') as FailureCode | undefined,
      balanceAfter:
        balanceAfter === undefined ? undefined : Money.from({ amount: balanceAfter, currency: str(row, 'wallet_currency') }),
      processedAt: optionalDate(row, 'processed_at'),
      attempts: row.attempts as number,
      nextAttemptAt: optionalDate(row, 'next_attempt_at'),
    });
  }
}

class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.walletId, entry.transactionId, entry.walletVersion, entry.direction,
        entry.money.toJSON().amount, entry.money.currency, entry.balanceBefore.toJSON().amount,
        entry.balanceAfter.toJSON().amount, entry.createdAt],
    );
  }
}

/** O claim do publisher (exportado para o EXPLAIN de outbox-indexes.test.ts conferir a consulta real). */
export const CLAIM_DUE_SQL = `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
       FROM outbox
       WHERE published_at IS NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id
       LIMIT ?
       FOR UPDATE SKIP LOCKED`;

/** O lag da outbox (idem). */
export const OLDEST_PENDING_SQL = `SELECT min(occurred_at) AS oldest FROM outbox WHERE published_at IS NULL`;

class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async append(messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      await this.em.execute(
        `INSERT INTO outbox (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
         VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`,
        [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload), message.occurredAt,
          message.attempts, message.nextAttemptAt],
      );
    }
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // SKIP LOCKED: cada publisher pega linhas que nenhum outro travou, sem esperar e sem lock global. O lock
    // vale até o commit do lote, então uma linha nunca está em dois lotes ao mesmo tempo. A busca usa o
    // índice parcial outbox_claim_idx (next_attempt_at, id) WHERE published_at IS NULL, na ordem do ORDER BY, sem
    // Sort (teste em outbox-indexes.test.ts). Mudou o WHERE ou o ORDER BY? Mude o índice junto.
    const rows = await this.em.execute<Row[]>(CLAIM_DUE_SQL, [now, limit]);
    return rows.map((row) => OutboxMessage.rehydrate({
      id: str(row, 'id'),
      aggregateId: str(row, 'aggregate_id'),
      eventType: str(row, 'event_type'),
      payload: row.payload as Record<string, unknown>,
      occurredAt: date(row, 'occurred_at'),
      attempts: row.attempts as number,
      nextAttemptAt: date(row, 'next_attempt_at'),
    }));
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.updatePending(message, `published_at = ?`, [message.publishedAt ?? null]);
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    await this.updatePending(message, `attempts = ?, next_attempt_at = ?`, [message.attempts, message.nextAttemptAt]);
  }

  // Índice parcial outbox_pending_occurred_idx (occurred_at) WHERE published_at IS NULL: o min é a primeira entrada.
  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const [row] = await this.em.execute<Row[]>(OLDEST_PENDING_SQL);
    return row === undefined ? undefined : optionalDate(row, 'oldest');
  }

  // Guarda `published_at IS NULL`: com a linha travada por claimDue, zero linhas aqui é bug, e o lote é desfeito.
  private async updatePending(message: OutboxMessage, set: string, params: unknown[]): Promise<void> {
    const rows = await this.em.execute<Row[]>(
      `UPDATE outbox SET ${set} WHERE id = ? AND published_at IS NULL RETURNING id`,
      [...params, message.id],
    );
    if (rows.length !== 1) {
      throw new Error(`Outbox message ${message.id} was not pending under the claim lock`);
    }
  }
}

class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    // Alvo explícito: só a PK da inbox significa "já recebida". Sem alvo, o DO NOTHING esconderia qualquer
    // outra violação (ARCHITECTURE 5.4). Uma entrega concorrente espera o commit da primeira e cai aqui.
    const rows = await this.em.execute<Row[]>(
      `INSERT INTO inbox (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT ON CONSTRAINT inbox_pk DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const [row] = await this.em.execute<Row[]>(
      `SELECT consumer_name, message_id, payload_hash, received_at, processed_at
       FROM inbox WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    if (row === undefined) return undefined;
    return InboxMessage.rehydrate({
      consumerName: str(row, 'consumer_name'),
      messageId: str(row, 'message_id'),
      payloadHash: str(row, 'payload_hash'),
      receivedAt: date(row, 'received_at'),
      processedAt: optionalDate(row, 'processed_at'),
    });
  }
}

/** Repositórios ligados ao EntityManager da transação corrente. */
export function sqlRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new SqlWalletRepository(em),
    transactions: new SqlWagerTransactionRepository(em),
    ledger: new SqlLedgerRepository(em),
    outbox: new SqlOutboxRepository(em),
    inbox: new SqlInboxRepository(em),
  };
}
