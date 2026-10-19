import type { EventContext } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  isReferenceWaitExhausted,
  nextReferenceAttemptAt,
  type PendingReferencePolicy,
} from '../../domain/pending-reference-policy';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import { type Metrics, NOOP_METRICS } from '../ports/metrics';
import type { UnitOfWork } from '../ports/unit-of-work';
import { decideUnderLock, wagerEvents } from './wager-rules';

/**
 * `noop` não muda nada: a linha não existe (`not_found`), já não está pendente (`not_pending`, outra instância
 * resolveu antes) ou ainda não venceu (`not_due`, outra instância já contou esta tentativa e reagendou).
 */
export type NoopReason = 'not_found' | 'not_pending' | 'not_due';

/**
 * `resolved`: saiu de PENDING_REFERENCE pelas regras (PROCESSED ou REJECTED). `expired`: o prazo acabou e a
 * referência continuava inutilizável (REJECTED com REFERENCE_NOT_FOUND ou REFERENCE_NOT_PROCESSED).
 * `still_pending`: a tentativa foi contada e reagendada.
 */
export type ResolveOutcome =
  | { outcome: 'resolved'; transaction: WagerTransaction }
  | { outcome: 'expired'; transaction: WagerTransaction }
  | { outcome: 'still_pending'; transaction: WagerTransaction }
  | { outcome: 'noop'; reason: NoopReason; transaction: WagerTransaction | undefined };

/**
 * Reavalia UMA transação PENDING_REFERENCE. É o que o worker chama para cada pendente vencida (ARCHITECTURE 8).
 * Uma transação SQL, nesta ordem (ARCHITECTURE 5.11):
 *   1. lê a linha SEM lock, só para descobrir o walletId (imutável);
 *   2. FOR UPDATE na wallet: a mesma ordem de locks da submissão (wallet primeiro, sempre);
 *   3. relê a linha sob o lock; sem efeito se ela já não está pendente ou se ainda não venceu;
 *   4. as mesmas regras da submissão; se a referência continua inutilizável, expira ou reagenda.
 */
export class ResolvePendingReference {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: PendingReferencePolicy,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {}

  async execute(transactionId: string, correlationId: string = this.ids.next()): Promise<ResolveOutcome> {
    const result = await this.perform(transactionId, correlationId);
    // Depois do commit. Quem sai de PENDING_REFERENCE para PROCESSED ou REJECTED conta como transição de status
    // (a entrada em PENDING_REFERENCE foi contada pela submissão); `still_pending` e `noop` não mudam status.
    if (result.outcome === 'resolved' || result.outcome === 'expired') {
      const { status, kind, failureCode } = result.transaction;
      this.metrics.increment('wager_transactions_total', { status, kind });
      if (failureCode !== undefined) this.metrics.increment('wager_rejections_total', { failure_code: failureCode });
    }
    return result;
  }

  private async perform(transactionId: string, correlationId: string): Promise<ResolveOutcome> {
    return this.unitOfWork.run(async (repositories) => {
      const unlocked = await repositories.transactions.findById(transactionId);
      if (unlocked === undefined) return { outcome: 'noop', reason: 'not_found', transaction: undefined };

      const wallet = await repositories.wallets.lockById(unlocked.walletId);
      // A FK garante a wallet; ausência aqui é corrupção, não regra de negócio.
      if (wallet === undefined) throw new Error(`Wallet ${unlocked.walletId} of transaction ${transactionId} is missing`);

      // Releitura sob o lock: em READ COMMITTED, este SELECT enxerga o que outra instância commitou enquanto
      // esperávamos o FOR UPDATE. Toda mudança desta linha acontece sob este mesmo lock, então o que lemos
      // agora não muda até o commit.
      const tx = await repositories.transactions.findById(transactionId);
      if (tx === undefined || tx.status !== WagerTransactionStatus.PendingReference) {
        return { outcome: 'noop', reason: 'not_pending', transaction: tx };
      }
      // `now` é lido depois do lock: quem esperou na fila do FOR UPDATE compara com o relógio atual.
      const now = this.clock.now();
      // Dois workers listaram a mesma linha vencida: o primeiro contou a tentativa e reagendou para o futuro;
      // o segundo, ao reler, vê o novo next_attempt_at e para aqui. Um único incremento por vencimento.
      if (tx.nextAttemptAt !== undefined && tx.nextAttemptAt.getTime() > now.getTime()) {
        return { outcome: 'noop', reason: 'not_due', transaction: tx };
      }

      const expectedVersion = wallet.version;
      const outcome = await decideUnderLock(tx, wallet, repositories.transactions, this.ids, now);
      let expired = false;

      if (outcome.kind === 'wait') {
        // Resolver vem antes de expirar: a referência que chegou no fim do prazo ainda é aplicada.
        if (!isReferenceWaitExhausted(tx.createdAt, tx.attempts, now, this.policy)) {
          // Só conta a tentativa e reagenda. Sem evento: PendingReference sai uma vez, na entrada.
          tx.registerReferenceRetry(nextReferenceAttemptAt(tx.createdAt, tx.attempts + 1, now, this.policy));
          await repositories.transactions.updatePendingReference(tx);
          return { outcome: 'still_pending', transaction: tx };
        }
        // Saldo observado lido sob o lock, como em qualquer rejeição (ARCHITECTURE 5.8).
        tx.expireReferenceWait(outcome.reference, wallet.balance, now);
        expired = true;
      }

      await repositories.transactions.updatePendingReference(tx);
      const entry = outcome.kind === 'decided' ? outcome.entry : undefined;
      if (entry !== undefined) {
        await repositories.ledger.append(entry);
        await repositories.wallets.saveBalance(wallet, expectedVersion);
      }
      const context = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId,
        causationId: tx.id,
        occurredAt: now,
      });
      await repositories.outbox.append(
        wagerEvents(tx, wallet, entry, context).map((e) => OutboxMessage.enqueue(e)),
      );
      return { outcome: expired ? 'expired' : 'resolved', transaction: tx };
    });
  }
}
