import { describe, expect, test } from 'bun:test';
import type { IntegrationEvent } from '../../../src/domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { FailureCode, WagerTransactionKind as Kind } from '../../../src/domain/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { brl, NOW, newTx, nextId, processedTx, reversalOf, walletWith } from './support';

/*
 * Envelope de todos os eventos (enunciado: eventId, eventType, aggregateId, correlationId, causationId opcional,
 * occurredAt, version, data). Cada subclasse é comparada com o JSON inteiro; `data` só carrega valores JSON simples,
 * com o dinheiro como MoneyProps (string), nunca uma instância de Money.
 */

const withCausation = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'cause-1', occurredAt: NOW };
const withoutCausation = { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: NOW };

const money = (amount: string) => ({ amount, currency: 'BRL' });

function processed(ctx: typeof withCausation | typeof withoutCausation) {
  const tx = processedTx({ id: 'tx-1', externalTransactionId: 'ext-1', kind: Kind.Win, money: brl('25.00') });
  return {
    event: WagerTransactionProcessed.from(tx, ctx),
    eventType: 'WagerTransactionProcessed',
    aggregateId: 'wallet-1',
    data: {
      transactionId: 'tx-1', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-a',
      externalTransactionId: 'ext-1', kind: 'WIN', money: money('25.00'), balanceAfter: money('90.00'),
    },
  };
}

function rejected(ctx: typeof withCausation | typeof withoutCausation) {
  const tx = newTx({ id: 'tx-1', externalTransactionId: 'ext-1', money: brl('80.00') });
  tx.reject(FailureCode.InsufficientFunds, brl('20.00'), NOW);
  return {
    event: WagerTransactionRejected.from(tx, ctx),
    eventType: 'WagerTransactionRejected',
    aggregateId: 'wallet-1',
    data: {
      transactionId: 'tx-1', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-a',
      externalTransactionId: 'ext-1', kind: 'BET', money: money('80.00'),
      failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: money('20.00'),
    },
  };
}

function pendingReference(ctx: typeof withCausation | typeof withoutCausation) {
  const tx = reversalOf(processedTx({ externalTransactionId: 'bet-9' }), { id: 'tx-1', externalTransactionId: 'ext-1' });
  tx.markPendingReference(new Date(NOW.getTime() + 1_000));
  return {
    event: WagerTransactionPendingReference.from(tx, ctx),
    eventType: 'WagerTransactionPendingReference',
    aggregateId: 'wallet-1',
    data: {
      transactionId: 'tx-1', walletId: 'wallet-1', playerId: 'player-1', providerId: 'provider-a',
      externalTransactionId: 'ext-1', kind: 'REFUND', money: money('10.00'),
      referenceExternalTransactionId: 'bet-9', attempts: 0, nextAttemptAt: '2026-10-17T12:00:01.000Z',
    },
  };
}

function balanceChanged(ctx: typeof withCausation | typeof withoutCausation) {
  const wallet = walletWith('100.00');
  const entry = wallet.debit({ money: brl('80.00'), transactionId: 'tx-1', entryId: nextId(), at: NOW });
  return {
    event: WalletBalanceChanged.from(wallet, entry, ctx),
    eventType: 'WalletBalanceChanged',
    aggregateId: wallet.id,
    data: {
      walletId: wallet.id, transactionId: 'tx-1', direction: LedgerDirection.Debit, money: money('80.00'),
      balanceBefore: money('100.00'), balanceAfter: money('20.00'), walletVersion: 2,
    },
  };
}

const builders = [
  ['WagerTransactionProcessed', processed],
  ['WagerTransactionRejected', rejected],
  ['WagerTransactionPendingReference', pendingReference],
  ['WalletBalanceChanged', balanceChanged],
] as const;

describe.each(builders)('%s envelope', (_name, build) => {
  test('serializes the whole envelope, with causationId', () => {
    const { event, eventType, aggregateId, data } = build(withCausation);
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: 'evt-1',
      eventType,
      aggregateId,
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-10-17T12:00:00.000Z',
      version: 1,
      data,
    });
  });

  test('without causationId the key is absent, not null', () => {
    const { event, eventType, aggregateId, data } = build(withoutCausation);
    const json = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
    expect('causationId' in json).toBe(false);
    expect(json).toEqual({
      eventId: 'evt-1',
      eventType,
      aggregateId,
      correlationId: 'corr-1',
      occurredAt: '2026-10-17T12:00:00.000Z',
      version: 1,
      data,
    });
  });

  test('data survives a JSON round trip unchanged: only plain values, money as MoneyProps', () => {
    const { event } = build(withCausation);
    const data: IntegrationEvent<unknown>['data'] = event.data;
    expect(JSON.parse(JSON.stringify(data))).toEqual(data as never);
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        expect(Object.keys(value).sort(), key).toEqual(['amount', 'currency']);
        expect(typeof (value as { amount: unknown }).amount).toBe('string');
      }
    }
  });
});
