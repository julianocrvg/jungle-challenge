import { backoffDelayMs } from '../../domain/backoff';
import type { EventContext } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { UnitOfWork } from '../ports/unit-of-work';
import { decideUnderLock, wagerEvents } from './wager-rules';

/**
 * `resolved`: saiu de PENDING_REFERENCE (PROCESSED ou REJECTED). `still_pending`: a referência continua
 * inutilizável, a tentativa foi contada e reagendada. `noop`: a linha não existe ou já não estava pendente
 * (outra instância resolveu antes).
 */
export type ResolveOutcome =
  | { outcome: 'resolved'; transaction: WagerTransaction }
  | { outcome: 'still_pending'; transaction: WagerTransaction }
  | { outcome: 'noop'; transaction: WagerTransaction | undefined };

/**
 * Reavalia UMA transação PENDING_REFERENCE. Núcleo do worker da fatia 8 (que vai cuidar do agendamento,
 * do SKIP LOCKED e do limite de tentativas). Uma transação SQL, nesta ordem (ARCHITECTURE 5.11):
 *   1. lê a linha SEM lock, só para descobrir o walletId (imutável);
 *   2. FOR UPDATE na wallet: a mesma ordem de locks da submissão (wallet primeiro, sempre);
 *   3. relê a linha sob o lock; se já não está PENDING_REFERENCE, termina sem efeito;
 *   4. as mesmas regras da submissão; UPDATE com guarda de status, ledger, saldo e outbox.
 */
export class ResolvePendingReference {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(transactionId: string, correlationId: string = this.ids.next()): Promise<ResolveOutcome> {
    return this.unitOfWork.run(async (repositories) => {
      const unlocked = await repositories.transactions.findById(transactionId);
      if (unlocked === undefined) return { outcome: 'noop', transaction: undefined };

      const wallet = await repositories.wallets.lockById(unlocked.walletId);
      // A FK garante a wallet; ausência aqui é corrupção, não regra de negócio.
      if (wallet === undefined) throw new Error(`Wallet ${unlocked.walletId} of transaction ${transactionId} is missing`);

      // Releitura sob o lock: em READ COMMITTED, este SELECT enxerga o que outra instância commitou enquanto
      // esperávamos o FOR UPDATE. Toda mudança de status acontece sob este mesmo lock, então o que lemos
      // agora não muda até o commit.
      const tx = await repositories.transactions.findById(transactionId);
      if (tx === undefined || tx.status !== WagerTransactionStatus.PendingReference) {
        return { outcome: 'noop', transaction: tx };
      }

      const now = this.clock.now();
      const expectedVersion = wallet.version;
      const outcome = await decideUnderLock(tx, wallet, repositories.transactions, this.ids, now);

      if (outcome.kind === 'wait') {
        // Só conta a tentativa e reagenda. Sem evento: PendingReference sai uma vez, na entrada.
        // attempts = tentativas de resolução já feitas; a próxima espera backoff(attempts + 1).
        const attempt = tx.attempts + 1;
        tx.registerReferenceRetry(new Date(now.getTime() + backoffDelayMs(attempt + 1)));
        await repositories.transactions.updatePendingReference(tx);
        return { outcome: 'still_pending', transaction: tx };
      }

      await repositories.transactions.updatePendingReference(tx);
      if (outcome.entry !== undefined) {
        await repositories.ledger.append(outcome.entry);
        await repositories.wallets.saveBalance(wallet, expectedVersion);
      }
      const context = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId,
        causationId: tx.id,
        occurredAt: now,
      });
      await repositories.outbox.append(
        wagerEvents(tx, wallet, outcome.entry, context).map((e) => OutboxMessage.enqueue(e)),
      );
      return { outcome: 'resolved', transaction: tx };
    });
  }
}
