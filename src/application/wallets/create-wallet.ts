import { DomainError } from '../../domain/errors';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { Money, type MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { InvalidCommandError, WalletAlreadyExistsError } from '../errors';
import { payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Abre a wallet em version 1. Saldo inicial > 0 gera, na mesma transação SQL, a OPENING sintética
 * (ARCHITECTURE 5.6), o lançamento CREDIT em wallet_version 1 e o WalletBalanceChanged na outbox.
 */
export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialBalance = this.money(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.ids.next();
    const base = { id: walletId, playerId: command.playerId, at: now };

    if (initialBalance.isZero()) {
      const wallet = Wallet.open({ ...base, currency: initialBalance.currency });
      await this.unitOfWork.run(async (repositories) => {
        await this.insertWallet(repositories.wallets.insertIfAbsent(wallet));
      });
      return wallet;
    }

    const opening = WagerTransaction.opening({
      id: this.ids.next(),
      walletId,
      playerId: command.playerId,
      money: initialBalance,
      payloadHash: payloadHash({
        kind: WagerTransactionKind.Opening, walletId, playerId: command.playerId, money: { ...initialBalance.toJSON() },
      }),
      createdAt: now,
    });
    const { wallet, openingEntry } = Wallet.openWithBalance({
      ...base, initialBalance, transactionId: opening.id, entryId: this.ids.next(),
    });
    opening.markProcessed({ balanceAfter: wallet.balance, at: now });
    const event = WalletBalanceChanged.from(wallet, openingEntry, {
      eventId: this.ids.next(), correlationId: command.correlationId, occurredAt: now,
    });

    await this.unitOfWork.run(async (repositories) => {
      // A wallet primeiro: a OPENING e o lançamento dependem dela pelas FKs.
      await this.insertWallet(repositories.wallets.insertIfAbsent(wallet));
      if (!(await repositories.transactions.insertIfAbsent(opening))) {
        throw new Error(`Opening transaction for new wallet ${walletId} already exists`);
      }
      await repositories.ledger.append(openingEntry);
      await repositories.outbox.append([OutboxMessage.enqueue(event)]);
    });
    return wallet;
  }

  private async insertWallet(inserted: Promise<boolean>): Promise<void> {
    if (!(await inserted)) {
      throw new WalletAlreadyExistsError('A wallet already exists for this player and currency');
    }
  }

  private money(props: MoneyProps): Money {
    try {
      return Money.from(props);
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidCommandError(error.message, { cause: error });
      throw error;
    }
  }
}
