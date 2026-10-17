import { InvalidTransactionStateError } from '../errors';
import type { MoneyProps } from '../money';
import { type FailureCode, type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction';
import { type EventContext, IntegrationEvent } from './integration-event';

/** Identificação comum dos eventos de transação. */
interface WagerTransactionEventData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function baseData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    walletId: tx.walletId,
    playerId: tx.playerId,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvalidTransactionStateError(`Event requires a ${expected} transaction, got ${tx.status}`);
  }
}

// aggregateId = walletId em todos os eventos: a wallet é a unidade de concorrência e de ordenação.

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  balanceAfter: MoneyProps;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: { ...baseData(tx), balanceAfter: (tx.balanceAfter as NonNullable<typeof tx.balanceAfter>).toJSON() },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balanceAfter: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...baseData(tx),
        failureCode: tx.failureCode as FailureCode,
        balanceAfter: (tx.balanceAfter as NonNullable<typeof tx.balanceAfter>).toJSON(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string | null;
}

/** Reversão cuja referência ainda não existe (ou não terminou). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        ...baseData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId as string,
        attempts: tx.attempts,
        nextAttemptAt: tx.nextAttemptAt?.toISOString() ?? null,
      },
    });
  }
}
