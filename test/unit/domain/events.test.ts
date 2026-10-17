import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError, InvalidTransactionStateError } from '../../../src/domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { FailureCode, WagerTransactionKind as Kind } from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { brl, NOW, newTx, nextId, processedTx, reversalOf, walletWith } from './support';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'cause-1', occurredAt: NOW };

describe('WalletBalanceChanged', () => {
  test('serializes the envelope with money as MoneyProps strings', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.debit({ money: brl('80.00'), transactionId: 'tx-1', entryId: nextId(), at: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(JSON.parse(JSON.stringify(event))).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-10-17T12:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        walletVersion: 3,
      },
    });
  });

  test('omits causationId when absent', () => {
    const wallet = walletWith('0.00');
    const entry = wallet.credit({ money: brl('1.00'), transactionId: 't', entryId: nextId(), at: NOW });
    const { causationId: _omit, ...withoutCausation } = ctx;
    const json = WalletBalanceChanged.from(wallet, entry, withoutCausation).toJSON();
    expect('causationId' in json).toBe(false);
  });

  test('rejects an entry from another wallet', () => {
    const other = Wallet.open({ id: 'other', playerId: 'p', currency: 'BRL', at: NOW });
    const wallet = walletWith('10.00');
    const entry = other.credit({ money: brl('1.00'), transactionId: 't', entryId: nextId(), at: NOW });
    expect(() => WalletBalanceChanged.from(wallet, entry, ctx)).toThrow(InvalidLedgerEntryError);
  });

  test('data holds only plain JSON values, never Money instances', () => {
    const wallet = walletWith('5.00');
    const entry = wallet.debit({ money: brl('1.00'), transactionId: 't', entryId: nextId(), at: NOW });
    const data = WalletBalanceChanged.from(wallet, entry, ctx).data;
    expect(JSON.parse(JSON.stringify(data))).toEqual(data as never);
  });
});

describe('WagerTransactionProcessed', () => {
  test('describes the processed transaction with the observed balance, keyed by wallet', () => {
    const tx = processedTx({ kind: Kind.Win, money: brl('25.00') });
    const event = WagerTransactionProcessed.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.aggregateId).toBe(tx.walletId);
    expect(event.data).toMatchObject({
      transactionId: tx.id,
      kind: 'WIN',
      money: { amount: '25.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' },
    });
  });

  test('requires a PROCESSED transaction', () => {
    expect(() => WagerTransactionProcessed.from(newTx(), ctx)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransactionRejected', () => {
  test('carries the failureCode and the observed balance', () => {
    const tx = newTx();
    tx.reject(FailureCode.InsufficientFunds, brl('20.00'), NOW);
    const event = WagerTransactionRejected.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: { amount: '20.00', currency: 'BRL' } });
  });

  test('requires a REJECTED transaction', () => {
    expect(() => WagerTransactionRejected.from(processedTx(), ctx)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransactionPendingReference', () => {
  test('identifies the missing reference and the next attempt', () => {
    const tx = reversalOf(processedTx({ externalTransactionId: 'bet-9' }));
    tx.markPendingReference(new Date(NOW.getTime() + 1_000));
    const event = WagerTransactionPendingReference.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data).toMatchObject({
      referenceExternalTransactionId: 'bet-9',
      attempts: 0,
      nextAttemptAt: '2026-10-17T12:00:01.000Z',
    });
  });

  test('requires a PENDING_REFERENCE transaction', () => {
    expect(() => WagerTransactionPendingReference.from(newTx(), ctx)).toThrow(InvalidTransactionStateError);
  });
});
