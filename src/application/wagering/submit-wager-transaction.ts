import { DomainError } from '../../domain/errors';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransactionProcessed, WagerTransactionRejected } from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { Money, type MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  IdempotencyKeyConflictError,
  InvalidCommandError,
  ReferenceNotSupportedYetError,
  WalletNotFoundError,
} from '../errors';
import { payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';

/** Campos de negócio: exatamente o que entra no payloadHash (ARCHITECTURE 5.3). */
export interface WagerTransactionPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  payload: WagerTransactionPayload;
  /** Metadados de transporte: rastreiam a operação, mas não entram no hash. */
  correlationId: string;
  causationId?: string;
}

export interface SubmissionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export function hashWagerPayload(payload: WagerTransactionPayload): string {
  return payloadHash({ ...payload, money: { amount: payload.money.amount, currency: payload.money.currency } });
}

/**
 * Submissão de BET, WIN e LOSS, usada pela API e (fatia 7) pela fila. Uma única transação SQL, nesta ordem:
 *   1. FOR UPDATE na wallet, antes de qualquer INSERT (evita o deadlock da FK, ARCHITECTURE 5.1);
 *   2. decisão da regra sob o lock, em memória;
 *   3. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING já no estado final: a UNIQUE decide se é
 *      duplicata, e o payloadHash separa replay de conflito (ARCHITECTURE 5.2);
 *   4. ledger, UPDATE do saldo com `version` e outbox. Nada é publicado antes do commit.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    if (command.payload.referenceExternalTransactionId !== undefined) {
      throw new ReferenceNotSupportedYetError('Transactions with a reference are not supported yet');
    }
    const now = this.clock.now();
    // O id da transação é o primeiro gerado: os testes contam com essa ordem para forçar colisões.
    const tx = this.buildTransaction(command, this.ids.next(), now);

    return this.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.lockById(tx.walletId);
      if (wallet === undefined) throw new WalletNotFoundError(`Wallet ${tx.walletId} not found`);
      const expectedVersion = wallet.version;
      const entry = this.decide(tx, wallet, now);

      if (!(await repositories.transactions.insertIfAbsent(tx))) {
        // A decisão acima é descartada: nada dela foi gravado.
        const existing = await repositories.transactions.findByIdempotencyKey(tx.idempotencyKey);
        if (existing === undefined) throw new Error('Idempotency key conflicted but no transaction was found');
        if (!existing.matchesPayload(tx.payloadHash)) {
          throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
        }
        return { transaction: existing, idempotentReplay: true };
      }

      if (entry !== undefined) {
        await repositories.ledger.append(entry);
        await repositories.wallets.saveBalance(wallet, expectedVersion);
      }
      await repositories.outbox.append(this.events(tx, wallet, entry, command, now).map((e) => OutboxMessage.enqueue(e)));
      return { transaction: tx, idempotentReplay: false };
    });
  }

  private buildTransaction(command: SubmitWagerTransactionCommand, id: string, now: Date): WagerTransaction {
    const { payload } = command;
    try {
      return WagerTransaction.create({
        id,
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: hashWagerPayload(payload),
        walletId: payload.walletId,
        playerId: payload.playerId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: payload.kind,
        money: Money.from(payload.money),
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidCommandError(error.message, { cause: error });
      throw error;
    }
  }

  /**
   * Aplica a regra com a wallet já travada. Devolve o lançamento quando o saldo muda.
   * Ordem: dono da wallet, moeda, regra do tipo (ARCHITECTURE 5.7).
   */
  private decide(tx: WagerTransaction, wallet: Wallet, now: Date): WalletLedgerEntry | undefined {
    if (tx.playerId !== wallet.playerId) {
      tx.reject(FailureCode.PlayerMismatch, wallet.balance, now);
      return undefined;
    }
    if (tx.money.currency !== wallet.currency) {
      tx.reject(FailureCode.CurrencyMismatch, wallet.balance, now);
      return undefined;
    }
    const movement = { money: tx.money, transactionId: tx.id, entryId: this.ids.next(), at: now };
    let entry: WalletLedgerEntry | undefined;
    switch (tx.kind) {
      case WagerTransactionKind.Bet:
        if (wallet.balance.isLessThan(tx.money)) {
          tx.reject(tx.failureCodeForOverdraw(), wallet.balance, now);
          return undefined;
        }
        entry = wallet.debit(movement);
        break;
      case WagerTransactionKind.Win:
        entry = wallet.credit(movement);
        break;
      case WagerTransactionKind.Loss:
        // Registra o resultado da rodada: sem efeito no saldo e sem lançamento.
        break;
      default:
        // REFUND e ROLLBACK sempre têm referência e já pararam no 501 (fatia 4b).
        throw new ReferenceNotSupportedYetError(`${tx.kind} is not supported yet`);
    }
    tx.markProcessed({ balanceAfter: wallet.balance, at: now });
    return entry;
  }

  private events(
    tx: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    command: SubmitWagerTransactionCommand,
    now: Date,
  ): IntegrationEvent<unknown>[] {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    });
    const events: IntegrationEvent<unknown>[] = [
      tx.status === WagerTransactionStatus.Processed
        ? WagerTransactionProcessed.from(tx, context())
        : WagerTransactionRejected.from(tx, context()),
    ];
    if (entry !== undefined) events.push(WalletBalanceChanged.from(wallet, entry, context()));
    return events;
  }
}
