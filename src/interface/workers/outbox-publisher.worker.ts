import type { PublishOutboxBatch } from '../../application/outbox/publish-outbox-batch';
import type { Metrics } from '../../application/ports/metrics';
import type { StructuredLogger } from '../../application/ports/structured-logger';
import { errorFields } from '../../infrastructure/logging/describe-error';
import { runInContext } from '../../infrastructure/logging/request-context';

export interface OutboxPublisherWorkerOptions {
  /** Se falso, o laço não sobe com a aplicação (instâncias só de API, ou testes que chamam o lote direto). */
  enabled: boolean;
  batchSize: number;
  pollIntervalMs: number;
}

/**
 * Laço do publisher numa instância (ARCHITECTURE 6.5). Lote cheio: roda de novo na hora, porque pode haver
 * mais vencidos; lote incompleto: espera `pollIntervalMs`. Várias instâncias rodam em paralelo, e o SKIP LOCKED
 * do claim separa os lotes. `stop()` não interrompe o lote em andamento: espera o commit e não começa outro.
 */
export class OutboxPublisherWorker {
  private running: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly publishBatch: PublishOutboxBatch,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
    private readonly options: OutboxPublisherWorkerOptions,
  ) {}

  /** Hook do Nest: sobe o laço junto com a aplicação. */
  onApplicationBootstrap(): void {
    if (this.options.enabled) this.start();
  }

  /**
   * Hook do Nest, chamado no `app.close()` e no SIGTERM (`enableShutdownHooks`) antes de o pool do ORM fechar
   * (`onApplicationShutdown`): o lote em andamento ainda tem conexão para fazer o commit.
   */
  beforeApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Para de buscar lotes e espera o lote em andamento terminar (commit ou rollback). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = undefined;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      // Um contexto de log por lote, com correlationId próprio (ARCHITECTURE 11.3).
      const fullBatch = await runInContext(async () => {
        try {
          const result = await this.publishBatch.execute();
          return result.claimed >= this.options.batchSize;
        } catch (error) {
          // Banco fora do ar ou bug: o lote foi desfeito e as linhas seguem pendentes. Espera e tenta de novo.
          this.metrics.increment('outbox_tick_errors_total');
          this.logger.error('Outbox publisher tick failed', errorFields(error));
          return false;
        }
      });
      if (!fullBatch && !this.stopping) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wake?.(), this.options.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
