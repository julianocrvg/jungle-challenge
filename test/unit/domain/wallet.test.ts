import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidAmountError, InvalidLedgerEntryError } from '../../../src/domain/errors';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet-ledger-entry';
import { brl, NOW, nextId, walletWith } from './support';

const move = (amount: string, at = NOW) => ({ money: brl(amount), transactionId: nextId(), entryId: nextId(), at });

describe('Wallet.open', () => {
  test('starts at zero balance and version 1', () => {
    const wallet = Wallet.open({ id: 'w', playerId: 'p', currency: 'BRL', at: NOW });
    expect(wallet.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(NOW);
  });
});

describe('Wallet.openWithBalance', () => {
  const open = (initialBalance: Money) =>
    Wallet.openWithBalance({ id: 'w', playerId: 'p', at: NOW, initialBalance, transactionId: 'opening-tx', entryId: 'e1' });

  test('starts at the initial balance and version 1, with the OPENING credit at walletVersion 1', () => {
    const { wallet, openingEntry } = open(brl('100.00'));
    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry.walletVersion).toBe(1);
    expect(openingEntry.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry.transactionId).toBe('opening-tx');
    expect(openingEntry.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test('the next movement takes version 2', () => {
    const { wallet } = open(brl('100.00'));
    const entry = wallet.debit(move('80.00'));
    expect(wallet.version).toBe(2);
    expect(entry.walletVersion).toBe(2);
  });

  test('takes the currency from the initial balance', () => {
    const { wallet } = open(Money.from({ amount: '5.00', currency: 'USD' }));
    expect(wallet.currency).toBe('USD');
  });

  test('rejects a zero or negative initial balance (zero uses open, without an entry)', () => {
    expect(() => open(brl('0.00'))).toThrow(InvalidAmountError);
    expect(() => open(brl('1.00').negate())).toThrow(InvalidAmountError);
  });
});

describe('Wallet.credit and debit', () => {
  test('credit adds to the balance, bumps the version and returns the matching ledger entry', () => {
    const wallet = walletWith('0.00');
    const params = move('25.00');
    const entry = wallet.credit(params);

    expect(wallet.balance.toJSON().amount).toBe('25.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.walletVersion).toBe(2);
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe(params.transactionId);
    expect(entry.id).toBe(params.entryId);
    expect(entry.balanceBefore.toJSON().amount).toBe('0.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('25.00');
  });

  test('debit subtracts from the balance and returns a DEBIT entry carrying the new version', () => {
    const wallet = walletWith('100.00');
    const versionBefore = wallet.version;
    const entry = wallet.debit(move('80.00'));

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(versionBefore + 1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletVersion).toBe(wallet.version);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
  });

  test('updatedAt follows the movement time', () => {
    const wallet = walletWith('10.00');
    const later = new Date(NOW.getTime() + 5_000);
    wallet.debit(move('1.00', later));
    expect(wallet.updatedAt).toEqual(later);
  });

  test('debiting exactly the balance is allowed and leaves zero', () => {
    const wallet = walletWith('50.00');
    wallet.debit(move('50.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('overdraw throws and leaves balance and version untouched', () => {
    const wallet = walletWith('10.00');
    const version = wallet.version;
    expect(() => wallet.debit(move('10.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(version);
  });

  test('two bets of 80 over a balance of 100: only one fits', () => {
    const wallet = walletWith('100.00');
    wallet.debit(move('80.00'));
    expect(() => wallet.debit(move('80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
  });

  test.each(['0.00'])('rejects zero amount on credit and debit', (amount) => {
    const wallet = walletWith('10.00');
    expect(() => wallet.credit(move(amount))).toThrow(InvalidAmountError);
    expect(() => wallet.debit(move(amount))).toThrow(InvalidAmountError);
  });

  test('rejects a negative amount on credit and debit', () => {
    const wallet = walletWith('10.00');
    const negative = { ...move('1.00'), money: brl('1.00').negate() };
    expect(() => wallet.credit(negative)).toThrow(InvalidAmountError);
    expect(() => wallet.debit(negative)).toThrow(InvalidAmountError);
    expect(wallet.balance.toJSON().amount).toBe('10.00');
  });

  test('rejects an operation in another currency without touching the wallet', () => {
    const wallet = walletWith('10.00');
    const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('the balance always equals the sum of the returned ledger entries', () => {
    const { wallet, openingEntry } = Wallet.openWithBalance({
      id: 'w', playerId: 'p', at: NOW, initialBalance: brl('100.00'), transactionId: nextId(), entryId: nextId(),
    });
    const entries = [
      openingEntry,
      wallet.debit(move('30.50')),
      wallet.credit(move('0.75')),
      wallet.debit(move('70.25')),
    ];
    const sum = entries.reduce(
      (total, e) => (e.direction === LedgerDirection.Credit ? total.add(e.money) : total.subtract(e.money)),
      Money.zero('BRL'),
    );
    expect(wallet.balance.equals(sum)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(wallet.version).toBe(4);
  });
});

describe('Wallet.rehydrate', () => {
  test('restores the persisted state as-is', () => {
    const wallet = Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: 'BRL', balance: brl('42.00'), version: 7, createdAt: NOW, updatedAt: NOW,
    });
    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e', walletId: 'w', transactionId: 't', walletVersion: 2, direction: LedgerDirection.Credit,
    money: brl('10.00'), balanceBefore: brl('5.00'), balanceAfter: brl('15.00'), createdAt: NOW,
  };

  test('create accepts a balanced entry', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, balanceBefore: brl('15.00'), balanceAfter: brl('5.00') })
        .isBalanced(),
    ).toBe(true);
  });

  test('create rejects arithmetic that does not close', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('15.01') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit })).toThrow(InvalidLedgerEntryError);
  });

  test('create rejects zero amount, bad version and negative resulting balance', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: Money.zero('BRL'), balanceAfter: brl('5.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base, direction: LedgerDirection.Debit, balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rehydrate does not revalidate, so isBalanced exposes a corrupted entry', () => {
    expect(WalletLedgerEntry.rehydrate({ ...base, balanceAfter: brl('99.00') }).isBalanced()).toBe(false);
  });

  test('has no mutators: only data fields and isBalanced on the prototype', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((n) => n !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});
