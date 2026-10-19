import { TransientInfrastructureError } from '../../application/errors';
import type { Metrics } from '../../application/ports/metrics';
import type { StructuredLogger } from '../../application/ports/structured-logger';
import type { PendingReferenceQueries } from '../../application/wagering/pending-reference-queries';
import type { ResolvePendingReference } from '../../application/wagering/resolve-pending-reference';
import { sqlStateOf } from '../../infrastructure/persistence/database-errors';
import { errorFields } from '../../infrastructure/logging/describe-error';

export interface PendingReferenceWorkerOptions {
  /** Se falso, o laço não sobe com a aplicação (os testes chamam `runOnce` direto). */
  enabled: boolean;
  batchSize: number;
  /** Resolves em paralelo; cada um segura uma conexão (entra no orçamento do pool). */
  concurrency: number;
  pollIntervalMs: number;
}

export interface CycleResult {
  /** Pendentes vencidas listadas neste ciclo. */
  listed: number;
  /** Resolves que lançaram erro (desfeitos; a linha volta no próximo ciclo). */
  failed: number;
}

/**
 * Worker de PENDING_REFERENCE de uma instância (ARCHITECTURE 8). Cada ciclo lista as vencidas SEM lock e chama
 * o ResolvePendingReference para cada uma, com no máximo `concurrency` em paralelo. Várias instâncias podem
 * listar a mesma linha: quem decide é a releitura sob o lock da wallet, dentro do resolve.
 */
export class PendingReferenceWorker {
  private running: Promise<void> | undefined;
  private stopping = false;
  private wake: (() => void) | undefined;

  constructor(
    private readonly resolve: ResolvePendingReference,
    private readonly queries: PendingReferenceQueries,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
    private readonly options: PendingReferenceWorkerOptions,
  ) {}

  /** Hook do Nest: sobe o laço junto com a aplicação. */
  onApplicationBootstrap(): void {
    if (this.options.enabled) this.start();
  }

  /** Hook do Nest (`app.close()` e SIGTERM), antes de o pool do ORM fechar: os resolves em andamento ainda fazem commit. */
  beforeApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /** Para de listar e de começar resolves; espera os que estão em andamento chegarem ao commit (ou rollback). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = undefined;
  }

  /**
   * Um ciclo. Durante o shutdown, nenhuma linha nova é iniciada: as que já começaram terminam, e as que
   * ficaram na lista continuam vencidas no banco para o próximo worker.
   */
  async runOnce(): Promise<CycleResult> {
    const ids = await this.queries.listDue(this.options.batchSize);
    let next = 0;
    let failed = 0;
    const lane = async (): Promise<void> => {
      while (!this.stopping && next < ids.length) {
        const id = ids[next++] as string;
        if (!(await this.resolveOne(id))) failed += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency, ids.length) }, lane));
    await this.recordBacklog();
    return { listed: ids.length, failed };
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let again = false;
      try {
        const result = await this.runOnce();
        // Só roda de novo na hora se o lote veio cheio E nada falhou. Uma linha que falha sempre (venenosa)
        // continua vencida e volta na próxima listagem; sem esta regra, ela viraria um laço quente.
        again = result.listed >= this.options.batchSize && result.failed === 0;
      } catch (error) {
        // A listagem falhou (banco fora do ar): nada foi alterado. Espera e tenta de novo.
        this.metrics.increment('pending_reference_cycle_errors_total');
        this.logger.error('Pending reference cycle failed', errorFields(error));
      }
      if (!again && !this.stopping) await this.idle();
    }
  }

  /** `true` se o resolve terminou (com qualquer resultado); `false` se lançou erro e foi desfeito. */
  private async resolveOne(transactionId: string): Promise<boolean> {
    const started = performance.now();
    try {
      const result = await this.resolve.execute(transactionId);
      switch (result.outcome) {
        case 'resolved':
          this.metrics.increment('pending_reference_resolved_total', { status: result.transaction.status });
          this.logger.info('Pending reference resolved', {
            transactionId, walletId: result.transaction.walletId, status: result.transaction.status,
            failureCode: result.transaction.failureCode,
          });
          break;
        case 'expired':
          this.metrics.increment('pending_reference_expired_total', { failureCode: result.transaction.failureCode ?? 'unknown' });
          this.logger.warn('Pending reference expired', {
            transactionId, walletId: result.transaction.walletId, failureCode: result.transaction.failureCode,
            attempts: result.transaction.attempts,
          });
          break;
        case 'still_pending':
          this.metrics.increment('pending_reference_retries_total');
          break;
        case 'noop':
          this.metrics.increment('pending_reference_noop_total', { reason: result.reason });
          break;
      }
      return true;
    } catch (error) {
      // O resolve foi desfeito por inteiro (nem a tentativa foi contada) e a linha segue vencida. Só nome,
      // SQLSTATE e frames: a mensagem do erro é texto livre e fica fora do log.
      const sqlState = sqlStateOf(error);
      if (error instanceof TransientInfrastructureError) {
        this.metrics.increment('pending_reference_errors_total', { reason: sqlState ?? 'transient' });
        this.logger.warn('Pending reference resolve failed; retried next cycle', {
          transactionId, ...errorFields(error),
        });
      } else {
        this.metrics.increment('pending_reference_errors_total', { reason: sqlState ?? 'unexpected' });
        this.logger.error('Unexpected error resolving pending reference', {
          transactionId, ...errorFields(error),
        });
      }
      return false;
    } finally {
      this.metrics.observe('pending_reference_resolve_seconds', (performance.now() - started) / 1000);
    }
  }

  private async recordBacklog(): Promise<void> {
    try {
      const backlog = await this.queries.backlog();
      this.metrics.gauge('pending_reference_pending', backlog.pending);
      this.metrics.gauge('pending_reference_oldest_age_seconds', backlog.oldestAgeSeconds);
    } catch (error) {
      // Só a métrica fica desatualizada; o ciclo em si já terminou.
      this.logger.warn('Pending reference backlog metric failed', { ...errorFields(error) });
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
