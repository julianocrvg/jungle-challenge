import type { BackoffPolicy } from '../../domain/backoff';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { Clock } from '../ports/clock';
import type { EventPublisher, PublishFailure, PublishResult } from '../ports/event-publisher';
import type { Metrics } from '../ports/metrics';
import type { StructuredLogger } from '../ports/structured-logger';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface PublishOutboxBatchOptions {
  batchSize: number;
  sendTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  backoff: BackoffPolicy;
}

export interface PublishOutboxBatchResult {
  claimed: number;
  published: number;
  retried: number;
}

/** A chamada ao broker passou do timeout. Resultado ambíguo: o broker pode ter aceitado as mensagens. */
export class PublishTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Event publisher did not answer within ${timeoutMs}ms`);
    this.name = 'PublishTimeoutError';
  }
}

/**
 * Um tick do publisher da outbox (ARCHITECTURE 6.2), numa única transação:
 * claim com SKIP LOCKED → envio com timeout → `published_at` nas aceitas e retry com backoff nas demais → commit.
 * Se o processo morrer antes do commit, nada foi marcado: as linhas voltam a ficar pendentes e são reenviadas
 * com o mesmo eventId (deduplication id). A entrega é at-least-once.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
    private readonly options: PublishOutboxBatchOptions,
  ) {}

  async execute(): Promise<PublishOutboxBatchResult> {
    return this.uow.run(async ({ outbox }) => {
      const messages = await outbox.claimDue(this.clock.now(), this.options.batchSize);
      let result: PublishOutboxBatchResult = { claimed: 0, published: 0, retried: 0 };

      if (messages.length > 0) {
        const outcome = await this.send(messages);
        const failedById = new Map(outcome.failed.map((failure) => [failure.id, failure]));
        const publishedIds = new Set(outcome.published);
        const now = this.clock.now();
        let published = 0;
        let retried = 0;

        for (const message of messages) {
          if (publishedIds.has(message.id)) {
            message.markPublished(now);
            await outbox.markPublished(message);
            published += 1;
          } else {
            // Falhou, ou o broker não citou a entrada na resposta: trata como falha e tenta de novo.
            message.scheduleRetry(now, this.options.backoff);
            await outbox.saveRetry(message);
            this.recordEntryFailure(message, failedById.get(message.id));
            retried += 1;
          }
        }
        this.metrics.increment('outbox_published_total', {}, published);
        result = { claimed: messages.length, published, retried };
      }

      // Lag: idade do pendente mais antigo, inclusive os que esperam retry. Zero quando não há pendentes.
      const oldest = await outbox.oldestPendingOccurredAt();
      const lagMs = oldest === undefined ? 0 : Math.max(this.clock.now().getTime() - oldest.getTime(), 0);
      this.metrics.gauge('outbox_lag_seconds', lagMs / 1000);
      return result;
    }, { idleInTransactionTimeoutMs: this.options.idleInTransactionTimeoutMs });
  }

  /**
   * Envia com teto de tempo para não segurar a conexão do pool indefinidamente. Uma exceção (rede, timeout,
   * fila inexistente) vira falha de todas as entradas: resultado ambíguo, resolvido pelo retry com o mesmo eventId.
   */
  private async send(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Rejeita antes de abortar: o abort pode resolver a chamada na mesma volta, e a corrida tem de
        // terminar como timeout (resultado ambíguo), não como uma resposta vazia do broker.
        reject(new PublishTimeoutError(this.options.sendTimeoutMs));
        controller.abort();
      }, this.options.sendTimeoutMs);
    });
    try {
      return await Promise.race([this.publisher.publish(messages, controller.signal), timeout]);
    } catch (error) {
      const reason = error instanceof PublishTimeoutError ? 'timeout' : 'call_error';
      this.metrics.increment('outbox_publish_call_failures_total', { reason });
      this.logger.warn('Outbox batch publish failed; scheduling retry', {
        reason,
        errorName: error instanceof Error ? error.name : 'unknown',
        batchSize: messages.length,
      });
      return { published: [], failed: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  private recordEntryFailure(message: OutboxMessage, failure: PublishFailure | undefined): void {
    const fields = {
      eventId: message.id,
      walletId: message.aggregateId,
      eventType: message.eventType,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt.toISOString(),
    };
    this.metrics.increment('outbox_retries_total', { fault: failure?.fault ?? 'call' });
    if (failure?.fault === 'sender') {
      // Erro do remetente: o broker recusou a entrada por causa do que enviamos. Indica bug; retry mesmo assim,
      // para nunca descartar o evento, mas com log de erro e contador próprio para alertar.
      this.metrics.increment('outbox_sender_faults_total', { code: failure.code });
      this.logger.error('Outbox entry rejected by broker (sender fault)', { ...fields, code: failure.code });
    } else if (failure !== undefined) {
      this.logger.warn('Outbox entry failed on broker side (service fault)', { ...fields, code: failure.code });
    }
  }
}
