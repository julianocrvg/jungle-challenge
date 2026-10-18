import { backoffDelayMs } from '../../domain/backoff';
import { DomainError } from '../../domain/errors';
import type { EventContext } from '../../domain/events/integration-event';
import { Money, type MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind } from '../../domain/wager-transaction';
import { IdempotencyKeyConflictError, InvalidCommandError, WalletNotFoundError } from '../errors';
import { payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';
import { decideUnderLock, wagerEvents } from './wager-rules';

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

/**
 * Lista explícita de campos: qualquer campo extra que chegue em runtime (por exemplo, metadados de transporte
 * de uma mensagem SQS) fica fora do hash. `referenceExternalTransactionId` entra só quando existe.
 */
export function hashWagerPayload(payload: WagerTransactionPayload): string {
  return payloadHash({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  });
}

/**
 * Submissão de qualquer transação de provedor, usada pela API e (fatia 7) pela fila. Uma única transação SQL:
 *   1. FOR UPDATE na wallet, antes de qualquer INSERT (evita o deadlock da FK, ARCHITECTURE 5.1);
 *   2. decisão sob o lock, em memória; reversões leem a referência e checam ALREADY_REVERSED aqui (5.10);
 *   3. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING já no estado final (PROCESSED, REJECTED ou
 *      PENDING_REFERENCE): a UNIQUE decide se é duplicata, e o payloadHash separa replay de conflito (5.2);
 *   4. ledger, UPDATE do saldo com `version` e outbox. Nada é publicado antes do commit.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    // O hash vem antes de tudo, do payload como chegou: nenhuma normalização do domínio entra nele.
    const hash = hashWagerPayload(command.payload);
    const now = this.clock.now();
    // O id da transação é o primeiro gerado: os testes contam com essa ordem para forçar colisões.
    const tx = this.buildTransaction(command, hash, this.ids.next(), now);

    return this.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.lockById(tx.walletId);
      if (wallet === undefined) throw new WalletNotFoundError(`Wallet ${tx.walletId} not found`);
      const expectedVersion = wallet.version;
      const outcome = await decideUnderLock(tx, wallet, repositories.transactions, this.ids, now);
      if (outcome.kind === 'wait') tx.markPendingReference(new Date(now.getTime() + backoffDelayMs(1)));

      if (!(await repositories.transactions.insertIfAbsent(tx))) {
        // A decisão acima é descartada: nada dela foi gravado. O replay devolve o estado ATUAL da linha
        // (uma PENDING_REFERENCE já resolvida responde com o resultado final).
        const existing = await repositories.transactions.findByIdempotencyKey(tx.idempotencyKey);
        if (existing === undefined) throw new Error('Idempotency key conflicted but no transaction was found');
        if (!existing.matchesPayload(tx.payloadHash)) {
          throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
        }
        return { transaction: existing, idempotentReplay: true };
      }

      const entry = outcome.kind === 'decided' ? outcome.entry : undefined;
      if (entry !== undefined) {
        await repositories.ledger.append(entry);
        await repositories.wallets.saveBalance(wallet, expectedVersion);
      }
      const context = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        causationId: command.causationId,
        occurredAt: now,
      });
      await repositories.outbox.append(wagerEvents(tx, wallet, entry, context).map((e) => OutboxMessage.enqueue(e)));
      return { transaction: tx, idempotentReplay: false };
    });
  }

  private buildTransaction(command: SubmitWagerTransactionCommand, hash: string, id: string, now: Date): WagerTransaction {
    const { payload } = command;
    try {
      return WagerTransaction.create({
        id,
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: hash,
        walletId: payload.walletId,
        playerId: payload.playerId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: payload.kind,
        money: Money.from(payload.money),
        referenceExternalTransactionId: payload.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof DomainError) throw new InvalidCommandError(error.message, { cause: error });
      throw error;
    }
  }
}
