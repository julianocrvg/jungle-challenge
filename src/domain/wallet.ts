import { InsufficientFundsError, InvalidAmountError, CurrencyMismatchError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dados de uma movimentação. `entryId` vem de fora (IdGenerator): o domínio não gera UUID. */
export interface MovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Aggregate root do saldo. Toda mudança de saldo devolve o lançamento correspondente, então saldo e
 * ledger não se separam no código. A exclusão mútua não é daqui: quem chama deve ter travado a linha
 * (SELECT ... FOR UPDATE) antes de ler o estado.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com saldo zero e version 1. Um saldo inicial não é atribuído aqui: entra por `credit`
   * dentro de uma transação OPENING, para que exista o lançamento correspondente (version 2).
   */
  static open(props: { id: string; playerId: string; currency: string; at: Date }): Wallet {
    return new Wallet(props.id, props.playerId, props.currency, Money.zero(props.currency), 1, props.at, props.at);
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Débito. Lança InsufficientFundsError se o saldo não cobrir; nesse caso nada muda. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError('Balance is lower than the amount to debit');
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  // Única porta de mudança de saldo: atualiza saldo, version e updatedAt juntos e gera o lançamento.
  private apply(direction: LedgerDirection, balanceAfter: Money, props: MovementProps): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const walletVersion = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      walletVersion,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version = walletVersion;
    this._updatedAt = props.at;
    return entry;
  }

  // Valor zero ou negativo é erro de programação: não há movimentação sem efeito (LOSS nem chega aqui).
  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError('Movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet is ${this.currency}, operation is ${money.currency}`);
    }
  }
}
