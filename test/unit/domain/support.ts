import { Money } from '../../../src/domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wager-transaction';
import { Wallet } from '../../../src/domain/wallet';

export const NOW = new Date('2026-10-17T12:00:00.000Z');
export const HASH = 'a'.repeat(64);

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let sequence = 0;
export const nextId = () => `id-${++sequence}`;

export function walletWith(balance: string, currency = 'BRL'): Wallet {
  const wallet = Wallet.open({ id: 'wallet-1', playerId: 'player-1', currency, at: NOW });
  if (balance !== '0.00') {
    wallet.credit({ money: Money.from({ amount: balance, currency }), transactionId: nextId(), entryId: nextId(), at: NOW });
  }
  return wallet;
}

export function txProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const id = overrides.id ?? nextId();
  return {
    id,
    providerId: 'provider-a',
    externalTransactionId: `ext-${id}`,
    idempotencyKey: `provider-a:ext-${id}`,
    payloadHash: HASH,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: NOW,
    ...overrides,
  };
}

export const newTx = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(txProps(overrides));

/** Transação já PROCESSED (por exemplo, a referência de uma reversão). */
export function processedTx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const tx = newTx(overrides);
  tx.markProcessed({
    // reversões PROCESSED sempre têm a referência resolvida
    referenceTransactionId: tx.requiresReference() ? 'resolved-reference-id' : undefined,
    balanceAfter: Money.from({ amount: '90.00', currency: tx.money.currency }),
    at: NOW,
  });
  return tx;
}

export function reversalOf(
  reference: WagerTransaction,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return newTx({
    kind: WagerTransactionKind.Refund,
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

export const statusOf = (tx: WagerTransaction): WagerTransactionStatus => tx.status;
