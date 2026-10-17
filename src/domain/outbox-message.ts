import { BackoffPolicy, backoffDelayMs, DEFAULT_BACKOFF } from './backoff';
import { InvalidMessageStateError } from './errors';
import type { IntegrationEvent } from './events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

/**
 * Evento aguardando publicação. Nasce na mesma transação da mudança financeira e só é publicado depois
 * do commit. O `id` é o `eventId`, que também serve de deduplication id no SQS.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
  ) {}

  /** Disponível para publicação imediatamente (nextAttemptAt = occurredAt). */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId, event.aggregateId, event.eventType, event.toJSON(), event.occurredAt, 0, event.occurredAt, undefined,
    );
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id, state.aggregateId, state.eventType, state.payload, state.occurredAt,
      state.attempts, state.nextAttemptAt, state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError('Outbox message was already published');
    }
    this._publishedAt = at;
  }

  /** Conta a tentativa que falhou e agenda a próxima com backoff exponencial. */
  scheduleRetry(now: Date, policy: BackoffPolicy = DEFAULT_BACKOFF): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError('Cannot retry a published outbox message');
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + backoffDelayMs(this._attempts, policy));
  }
}
