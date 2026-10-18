import { describe, expect, test } from 'bun:test';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet-ledger-entry';
import { brl, HASH, NOW, newTx, processedTx, reversalOf, txProps } from './support';

const LATER = new Date(NOW.getTime() + 1_000);

describe('WagerTransaction.create', () => {
  test('is born PENDING with no failure, no balance and zero attempts', () => {
    const tx = newTx();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.attempts).toBe(0);
    expect(tx.isTerminal()).toBe(false);
  });

  test.each(['internal', 'INTERNAL', 'Internal'])('the reserved provider "%s" can never be submitted', (providerId) => {
    expect(() => newTx({ providerId })).toThrow(InvalidTransactionError);
  });

  test('OPENING can never be submitted', () => {
    expect(() => newTx({ kind: Kind.Opening })).toThrow(InvalidTransactionError);
  });

  test('unknown kind is rejected', () => {
    expect(() => newTx({ kind: 'JACKPOT' as Kind })).toThrow(InvalidTransactionError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s requires a reference', (kind) => {
    expect(() => newTx({ kind })).toThrow(InvalidTransactionError);
    expect(() => newTx({ kind, referenceExternalTransactionId: ' ' })).toThrow(InvalidTransactionError);
    expect(newTx({ kind, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('BET cannot carry a reference, WIN and LOSS may', () => {
    expect(() => newTx({ kind: Kind.Bet, referenceExternalTransactionId: 'x' })).toThrow(InvalidTransactionError);
    expect(newTx({ kind: Kind.Win, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(false);
    expect(newTx({ kind: Kind.Loss, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(false);
  });

  test('zero amount is only valid for LOSS', () => {
    expect(newTx({ kind: Kind.Loss, money: brl('0.00') }).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => newTx({ kind, money: brl('0.00') })).toThrow(InvalidTransactionError);
    }
    expect(() => newTx({ kind: Kind.Bet, money: brl('1.00').negate() })).toThrow(InvalidTransactionError);
    expect(() => newTx({ kind: Kind.Loss, money: brl('1.00').negate() })).toThrow(InvalidTransactionError);
  });

  test('requires ids and a SHA-256 payload hash', () => {
    expect(() => newTx({ providerId: '' })).toThrow(InvalidTransactionError);
    expect(() => newTx({ roundId: ' ' })).toThrow(InvalidTransactionError);
    expect(() => newTx({ payloadHash: 'not-a-hash' })).toThrow(InvalidTransactionError);
    expect(() => newTx({ payloadHash: 'A'.repeat(64) })).toThrow(InvalidTransactionError);
  });

  test('only LOSS does not affect the balance', () => {
    expect(newTx({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(newTx({ kind: Kind.Win }).affectsBalance()).toBe(true);
    expect(newTx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
  });
});

describe('WagerTransaction.opening', () => {
  test('is internal, has no round or game and a deterministic idempotency key', () => {
    const tx = WagerTransaction.opening({
      id: 't', walletId: 'w1', playerId: 'p', money: brl('100.00'), payloadHash: HASH, createdAt: NOW,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.roundId).toBeUndefined();
    expect(tx.idempotencyKey).toBe('internal:opening:w1');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('requires a positive amount', () => {
    expect(() =>
      WagerTransaction.opening({ id: 't', walletId: 'w', playerId: 'p', money: brl('0.00'), payloadHash: HASH, createdAt: NOW }),
    ).toThrow(InvalidTransactionError);
  });
});

describe('payload matching', () => {
  test('same hash matches, a different hash is a conflict', () => {
    const tx = newTx();
    expect(tx.matchesPayload(HASH)).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });
});

describe('state transitions', () => {
  test('PENDING -> PROCESSED records balanceAfter and processedAt', () => {
    const tx = newTx();
    tx.markProcessed({ balanceAfter: brl('90.00'), at: LATER });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.balanceAfter?.toJSON().amount).toBe('90.00');
    expect(tx.processedAt).toEqual(LATER);
    expect(tx.isTerminal()).toBe(true);
  });

  test('a PROCESSED reversal needs its resolved reference id', () => {
    const tx = reversalOf(processedTx());
    expect(() => tx.markProcessed({ balanceAfter: brl('100.00'), at: LATER })).toThrow(InvalidTransactionError);
    tx.markProcessed({ referenceTransactionId: 'ref-id', balanceAfter: brl('100.00'), at: LATER });
    expect(tx.referenceTransactionId).toBe('ref-id');
  });

  test('PENDING -> REJECTED keeps the observed balance and the failure code', () => {
    const tx = newTx();
    tx.reject(FailureCode.InsufficientFunds, brl('20.00'), LATER);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.toJSON().amount).toBe('20.00');
  });

  test('INTERNAL_ERROR is a failure, not a rejection', () => {
    expect(() => newTx().reject(FailureCode.InternalError, brl('0.00'), LATER)).toThrow(InvalidTransactionError);
  });

  test('PENDING -> FAILED sets INTERNAL_ERROR without a balance', () => {
    const tx = newTx();
    tx.fail(LATER);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalError);
    expect(tx.balanceAfter).toBeUndefined();
  });

  test('balanceAfter must be non-negative and, when processed, in the transaction currency', () => {
    expect(() => newTx().markProcessed({ balanceAfter: brl('1.00').negate(), at: LATER })).toThrow(InvalidTransactionError);
    expect(() =>
      newTx().markProcessed({ balanceAfter: Money.from({ amount: '1.00', currency: 'USD' }), at: LATER }),
    ).toThrow(InvalidTransactionError);
    expect(() => newTx().reject(FailureCode.InsufficientFunds, brl('1.00').negate(), LATER)).toThrow(
      InvalidTransactionError,
    );
  });

  test('a CURRENCY_MISMATCH rejection keeps the observed balance in the wallet currency', () => {
    const tx = newTx({ money: Money.from({ amount: '10.00', currency: 'USD' }) });
    tx.reject(FailureCode.CurrencyMismatch, brl('100.00'), LATER);
    expect(tx.balanceAfter?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('PLAYER_MISMATCH is a rejection code', () => {
    const tx = newTx();
    tx.reject(FailureCode.PlayerMismatch, brl('5.00'), LATER);
    expect(tx.failureCode).toBe('PLAYER_MISMATCH');
  });

  test('a rejected reversal may keep the resolved reference; a non-reversal may not', () => {
    const refund = newTx({ kind: Kind.Refund, referenceExternalTransactionId: 'bet-1' });
    refund.reject(FailureCode.AlreadyReversed, brl('5.00'), LATER, 'ref-id');
    expect(refund.referenceTransactionId).toBe('ref-id');
    expect(() => newTx().reject(FailureCode.InsufficientFunds, brl('5.00'), LATER, 'ref-id')).toThrow(
      InvalidTransactionError,
    );
  });

  describe('PENDING_REFERENCE', () => {
    const pending = () => {
      const tx = reversalOf(processedTx());
      tx.markPendingReference(LATER);
      return tx;
    };

    test('PENDING -> PENDING_REFERENCE schedules the next attempt', () => {
      const tx = pending();
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.nextAttemptAt).toEqual(LATER);
      expect(tx.isTerminal()).toBe(false);
    });

    test('only reversals can wait for a reference', () => {
      expect(() => newTx().markPendingReference(LATER)).toThrow(InvalidTransactionError);
    });

    test('PENDING_REFERENCE -> PENDING_REFERENCE is not a transition, but a retry counts an attempt', () => {
      const tx = pending();
      expect(() => tx.markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
      const next = new Date(LATER.getTime() + 2_000);
      tx.registerReferenceRetry(next);
      expect(tx.attempts).toBe(1);
      expect(tx.nextAttemptAt).toEqual(next);
      expect(tx.status).toBe(Status.PendingReference);
    });

    test('retry is only valid while PENDING_REFERENCE', () => {
      expect(() => newTx().registerReferenceRetry(LATER)).toThrow(InvalidTransactionStateError);
    });

    test.each([
      ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed({ referenceTransactionId: 'r', balanceAfter: brl('1.00'), at: LATER })],
      ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.ReferenceNotFound, brl('1.00'), LATER)],
      ['FAILED', (tx: WagerTransaction) => tx.fail(LATER)],
    ])('PENDING_REFERENCE -> %s is valid and clears the next attempt', (_name, act) => {
      const tx = pending();
      act(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.nextAttemptAt).toBeUndefined();
    });
  });

  describe('terminal states never transition again', () => {
    const terminals: Array<[string, () => WagerTransaction]> = [
      ['PROCESSED', () => processedTx()],
      ['REJECTED', () => { const t = newTx(); t.reject(FailureCode.InsufficientFunds, brl('0.00'), NOW); return t; }],
      ['FAILED', () => { const t = newTx(); t.fail(NOW); return t; }],
    ];

    test.each(terminals)('%s rejects every transition', (_name, make) => {
      const tx = make();
      const before = { status: tx.status, failureCode: tx.failureCode, processedAt: tx.processedAt };
      expect(() => tx.markProcessed({ balanceAfter: brl('1.00'), at: LATER })).toThrow(InvalidTransactionStateError);
      expect(() => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), LATER)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(LATER)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference(LATER)).toThrow(InvalidTransactionStateError);
      expect({ status: tx.status, failureCode: tx.failureCode, processedAt: tx.processedAt }).toEqual(before);
    });
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('rebuilds terminal state as-is, without revalidating, and it still refuses new transitions', () => {
    const tx = WagerTransaction.rehydrate({
      ...txProps({ id: 'r1' }),
      roundId: 'round-1',
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balanceAfter: brl('20.00'),
      processedAt: NOW,
      attempts: 3,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.attempts).toBe(3);
    expect(() => tx.fail(LATER)).toThrow(InvalidTransactionStateError);
  });

  test('accepts states create would refuse (e.g. an OPENING row)', () => {
    const tx = WagerTransaction.rehydrate({ ...txProps({ kind: Kind.Opening }), status: Status.Processed, attempts: 0 });
    expect(tx.kind).toBe(Kind.Opening);
  });
});

describe('ledger direction', () => {
  test('BET debits; WIN and REFUND credit', () => {
    expect(newTx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(newTx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(reversalOf(processedTx()).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('LOSS has no ledger entry', () => {
    expect(() => newTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test('ROLLBACK is the inverse of its reference', () => {
    const rollback = (reference: WagerTransaction) =>
      newTx({ kind: Kind.Rollback, referenceExternalTransactionId: reference.externalTransactionId });

    const bet = processedTx({ kind: Kind.Bet });
    const win = processedTx({ kind: Kind.Win });
    const refund = processedTx({ kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId });

    expect(rollback(bet).ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback(win).ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback(refund).ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK without a valid reference cannot define a direction', () => {
    const rb = newTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => rb.ledgerDirectionFor(processedTx({ kind: Kind.Loss }))).toThrow(InvalidTransactionError);
  });
});

describe('overdraw failure code', () => {
  test('a BET without funds is INSUFFICIENT_FUNDS; a reversal that overdraws is REVERSAL_WOULD_OVERDRAW', () => {
    expect(newTx({ kind: Kind.Bet }).failureCodeForOverdraw()).toBe(FailureCode.InsufficientFunds);
    expect(reversalOf(processedTx()).failureCodeForOverdraw()).toBe(FailureCode.ReversalWouldOverdraw);
    expect(newTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' }).failureCodeForOverdraw()).toBe(
      FailureCode.ReversalWouldOverdraw,
    );
  });

  test('credits never overdraw', () => {
    expect(() => newTx({ kind: Kind.Win }).failureCodeForOverdraw()).toThrow(InvalidTransactionError);
  });
});

describe('validateReference', () => {
  const bet = () => processedTx({ kind: Kind.Bet, externalTransactionId: 'bet-1' });
  const refundOf = (ref: WagerTransaction, o = {}) =>
    newTx({ kind: Kind.Refund, referenceExternalTransactionId: ref.externalTransactionId, ...o });

  test('a PROCESSED BET with matching data resolves', () => {
    const ref = bet();
    expect(refundOf(ref).validateReference(ref)).toEqual({ outcome: 'resolved' });
  });

  test('absent reference waits', () => {
    expect(refundOf(bet()).validateReference(undefined)).toEqual({ outcome: 'wait' });
  });

  test('a reference still in PENDING_REFERENCE is treated as absent', () => {
    const waitingRefund = reversalOf(bet());
    waitingRefund.markPendingReference(LATER);
    const rollback = newTx({
      kind: Kind.Rollback, referenceExternalTransactionId: waitingRefund.externalTransactionId,
    });
    expect(rollback.validateReference(waitingRefund)).toEqual({ outcome: 'wait' });
  });

  test('a reference that is still PENDING also waits', () => {
    const ref = newTx({ kind: Kind.Bet });
    expect(refundOf(ref).validateReference(ref)).toEqual({ outcome: 'wait' });
  });

  test.each([
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, brl('0.00'), NOW)],
    ['FAILED', (t: WagerTransaction) => t.fail(NOW)],
  ])('a %s reference yields REFERENCE_NOT_PROCESSED', (_name, finish) => {
    const ref = newTx({ kind: Kind.Bet });
    finish(ref);
    expect(refundOf(ref).validateReference(ref)).toEqual({
      outcome: 'reject', failureCode: FailureCode.ReferenceNotProcessed,
    });
  });

  test('REFUND only references a BET', () => {
    for (const kind of [Kind.Win, Kind.Refund, Kind.Loss]) {
      const ref = processedTx({
        kind, ...(kind === Kind.Refund ? { referenceExternalTransactionId: 'bet-0' } : {}),
      });
      expect(refundOf(ref).validateReference(ref)).toEqual({
        outcome: 'reject', failureCode: FailureCode.InvalidReferenceKind,
      });
    }
  });

  test('ROLLBACK references a BET, a WIN or a REFUND, but not a ROLLBACK or a LOSS', () => {
    const rollbackOf = (ref: WagerTransaction) =>
      newTx({ kind: Kind.Rollback, referenceExternalTransactionId: ref.externalTransactionId });
    const betRef = bet();
    const refundRef = processedTx({ kind: Kind.Refund, referenceExternalTransactionId: betRef.externalTransactionId });
    for (const ref of [betRef, processedTx({ kind: Kind.Win }), refundRef]) {
      expect(rollbackOf(ref).validateReference(ref)).toEqual({ outcome: 'resolved' });
    }
    const rollbackRef = processedTx({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' });
    for (const ref of [rollbackRef, processedTx({ kind: Kind.Loss })]) {
      expect(rollbackOf(ref).validateReference(ref)).toEqual({
        outcome: 'reject', failureCode: FailureCode.InvalidReferenceKind,
      });
    }
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['round', { roundId: 'round-2' }],
  ])('a different %s yields REFERENCE_MISMATCH', (_name, override) => {
    const ref = processedTx({ kind: Kind.Bet, ...override });
    expect(refundOf(ref).validateReference(ref)).toEqual({
      outcome: 'reject', failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test('a different amount yields AMOUNT_MISMATCH (partial reversal is out of scope)', () => {
    const ref = processedTx({ kind: Kind.Bet, money: brl('10.00') });
    expect(refundOf(ref, { money: brl('4.00') }).validateReference(ref)).toEqual({
      outcome: 'reject', failureCode: FailureCode.AmountMismatch,
    });
  });

  test('a different currency yields CURRENCY_MISMATCH', () => {
    const ref = processedTx({ kind: Kind.Bet, money: Money.from({ amount: '10.00', currency: 'USD' }) });
    expect(refundOf(ref, { money: brl('10.00') }).validateReference(ref)).toEqual({
      outcome: 'reject', failureCode: FailureCode.CurrencyMismatch,
    });
  });

  test('validating a non-reversal is a programming error', () => {
    expect(() => newTx({ kind: Kind.Bet }).validateReference(undefined)).toThrow(InvalidTransactionError);
  });
});
