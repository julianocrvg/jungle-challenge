import { DomainError } from '../../domain/errors';
import type { EventContext } from '../../domain/events/integration-event';
import { InboxMessage } from '../../domain/inbox-message';
import { Money, type MoneyProps } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { nextReferenceAttemptAt, type PendingReferencePolicy } from '../../domain/pending-reference-policy';
import { WagerTransaction, type WagerTransactionKind } from '../../domain/wager-transaction';
import {
  ExternalTransactionIdConflictError, IdempotencyKeyConflictError, InboxMessageConflictError, InvalidCommandError,
  WalletNotFoundError,
} from '../errors';
import { type CanonicalValue, payloadHash } from '../payload-hash';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import { type Metrics, NOOP_METRICS } from '../ports/metrics';
import type { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work';
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

/** Entrada pela fila: a mensagem vai para a inbox na mesma transação SQL da mudança financeira. */
export interface InboxReceipt {
  consumerName: string;
  messageId: string;
}

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  payload: WagerTransactionPayload;
  /** Metadados de transporte: rastreiam a operação, mas não entram no hash. */
  correlationId: string;
  causationId?: string;
  /** Só no caminho do SQS. Ausente no HTTP. */
  inbox?: InboxReceipt;
}

export interface SubmissionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
  /** A mensagem já estava na inbox: entrega repetida, nada foi gravado nem travado. Sempre falso no HTTP. */
  duplicateDelivery: boolean;
}

/**
 * Lista explícita de campos: qualquer campo extra que chegue em runtime (por exemplo, metadados de transporte
 * de uma mensagem SQS) fica fora do hash. `referenceExternalTransactionId` entra só quando existe.
 */
function businessFields(payload: WagerTransactionPayload): CanonicalValue {
  return {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
}

/** `payloadHash` da transação: só os campos de negócio, igual no HTTP e no SQS (ARCHITECTURE 5.3). */
export function hashWagerPayload(payload: WagerTransactionPayload): string {
  return payloadHash(businessFields(payload));
}

/**
 * Hash da mensagem na inbox: a key **mais** os campos de negócio (ARCHITECTURE 7.2). Diferente do payloadHash:
 * duas mensagens com o mesmo messageId e keys diferentes são conflito, mesmo com o negócio idêntico.
 */
export function hashInboxMessage(idempotencyKey: string, payload: WagerTransactionPayload): string {
  return payloadHash({ idempotencyKey, payload: businessFields(payload) });
}

/**
 * Submissão de qualquer transação de provedor, usada pela API e pela fila. Uma única transação SQL:
 *   0. só pela fila: INSERT na inbox com ON CONFLICT DO NOTHING; se já existia, é entrega repetida (7.2);
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
    private readonly pendingPolicy: PendingReferencePolicy,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    let result: SubmissionResult;
    try {
      result = await this.perform(command);
    } catch (error) {
      this.countConflict(error);
      throw error;
    }
    // Depois do commit (a transação de `perform` já terminou): um rollback nunca chega aqui.
    this.countOutcome(command, result);
    return result;
  }

  /** 409 de idempotência: a mesma chave, id externo ou messageId com conteúdo diferente (não é duplicata). */
  private countConflict(error: unknown): void {
    if (error instanceof IdempotencyKeyConflictError) this.metrics.increment('wager_idempotency_conflicts_total', { kind: 'idempotency_key' });
    else if (error instanceof ExternalTransactionIdConflictError) this.metrics.increment('wager_idempotency_conflicts_total', { kind: 'external_id' });
    else if (error instanceof InboxMessageConflictError) this.metrics.increment('wager_idempotency_conflicts_total', { kind: 'inbox' });
  }

  /**
   * Duplicata = replay com a mesma chave e o mesmo payload (inclui perder a corrida do ON CONFLICT) ou a mesma
   * mensagem da fila entregue de novo. Uma duplicata NÃO conta como transação nova. Só a transação que
   * acabou de entrar em um status conta em `wager_transactions_total` (ARCHITECTURE 11.4).
   */
  private countOutcome(command: SubmitWagerTransactionCommand, result: SubmissionResult): void {
    const source = command.inbox === undefined ? 'http' : 'sqs';
    if (result.duplicateDelivery) {
      this.metrics.increment('wager_duplicates_total', { source, level: 'inbox' });
    } else if (result.idempotentReplay) {
      this.metrics.increment('wager_duplicates_total', { source, level: 'idempotency_key' });
    } else {
      const { status, kind, failureCode } = result.transaction;
      this.metrics.increment('wager_transactions_total', { status, kind });
      if (failureCode !== undefined) this.metrics.increment('wager_rejections_total', { failure_code: failureCode });
    }
  }

  private async perform(command: SubmitWagerTransactionCommand): Promise<SubmissionResult> {
    // O hash vem antes de tudo, do payload como chegou: nenhuma normalização do domínio entra nele.
    const hash = hashWagerPayload(command.payload);
    const now = this.clock.now();
    // O id da transação é o primeiro gerado: os testes contam com essa ordem para forçar colisões.
    const tx = this.buildTransaction(command, hash, this.ids.next(), now);

    return this.unitOfWork.run(async (repositories) => {
      if (command.inbox !== undefined) {
        const duplicate = await this.receive(repositories, command, command.inbox, now);
        if (duplicate !== undefined) return duplicate;
      }
      const wallet = await repositories.wallets.lockById(tx.walletId);
      if (wallet === undefined) throw new WalletNotFoundError(`Wallet ${tx.walletId} not found`);
      const expectedVersion = wallet.version;
      const outcome = await decideUnderLock(tx, wallet, repositories.transactions, this.ids, now);
      // Primeiro degrau do cronograma: backoff(1), limitado ao prazo (ARCHITECTURE 8.3).
      if (outcome.kind === 'wait') tx.markPendingReference(nextReferenceAttemptAt(tx.createdAt, 0, now, this.pendingPolicy));

      if (!(await repositories.transactions.insertIfAbsent(tx))) {
        // A decisão acima é descartada: nada dela foi gravado. O replay devolve o estado ATUAL da linha
        // (uma PENDING_REFERENCE já resolvida responde com o resultado final).
        const existing = await repositories.transactions.findByIdempotencyKey(tx.idempotencyKey);
        if (existing === undefined) throw new Error('Idempotency key conflicted but no transaction was found');
        if (!existing.matchesPayload(tx.payloadHash)) {
          throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
        }
        return { transaction: existing, idempotentReplay: true, duplicateDelivery: false };
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
      return { transaction: tx, idempotentReplay: false, duplicateDelivery: false };
    });
  }

  /**
   * Passo 0, antes do lock da wallet (ordem de 5.1). Quem decide a duplicata é a PK da inbox, não um SELECT
   * prévio. Se a mensagem já estava lá, ela foi commitada junto com a transação (nova ou replay), então a
   * transação existe e é devolvida sem travar nada. Qualquer erro depois deste passo desfaz também a inbox.
   */
  private async receive(
    repositories: TransactionalRepositories, command: SubmitWagerTransactionCommand, receipt: InboxReceipt, now: Date,
  ): Promise<SubmissionResult | undefined> {
    const message = InboxMessage.receive({
      consumerName: receipt.consumerName,
      messageId: receipt.messageId,
      payloadHash: hashInboxMessage(command.idempotencyKey, command.payload),
      receivedAt: now,
    });
    message.markProcessed(now); // recebimento e processamento entram no mesmo commit
    if (await repositories.inbox.insertIfAbsent(message)) return undefined;

    const existing = await repositories.inbox.find(receipt.consumerName, receipt.messageId);
    if (existing === undefined) throw new Error('Inbox message conflicted but was not found');
    if (!existing.matchesPayload(message.payloadHash)) {
      throw new InboxMessageConflictError(`Message ${receipt.messageId} was already received with a different payload`);
    }
    const transaction = await repositories.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (transaction === undefined) throw new Error(`Inbox message ${receipt.messageId} has no transaction`);
    return { transaction, idempotentReplay: true, duplicateDelivery: true };
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
