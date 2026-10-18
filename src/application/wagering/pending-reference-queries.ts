import type { Clock } from '../ports/clock';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PendingReferenceBacklog {
  pending: number;
  /** Idade da pendente mais antiga, a partir de `created_at` (0 quando não há nenhuma). */
  oldestAgeSeconds: number;
}

/**
 * Leituras do worker de PENDING_REFERENCE, cada uma numa transação curta e SEM lock em `wager_transactions`
 * (ARCHITECTURE 8.1). A decisão sobre cada linha é do ResolvePendingReference, sob o lock da wallet.
 */
export class PendingReferenceQueries {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** Ids das pendentes com `next_attempt_at <= now`, as mais antigas primeiro. */
  listDue(limit: number): Promise<string[]> {
    const now = this.clock.now();
    return this.unitOfWork.run((repositories) => repositories.transactions.listDuePendingReferences(now, limit));
  }

  async backlog(): Promise<PendingReferenceBacklog> {
    const { pending, oldestCreatedAt } = await this.unitOfWork.run((r) => r.transactions.pendingReferenceStats());
    const ageMs = oldestCreatedAt === undefined ? 0 : Math.max(0, this.clock.now().getTime() - oldestCreatedAt.getTime());
    return { pending, oldestAgeSeconds: ageMs / 1000 };
  }
}
