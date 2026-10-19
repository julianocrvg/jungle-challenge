import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Clock } from '../../application/ports/clock';
import { CLOCK } from '../../application/ports/clock';
import { METRICS, type Metrics } from '../../application/ports/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/unit-of-work';
import { InMemoryMetrics } from '../../infrastructure/metrics/in-memory-metrics';
import { PROMETHEUS_CONTENT_TYPE, renderGauge, renderPrometheus } from '../../infrastructure/metrics/prometheus';

/** Teto do cálculo do lag no scrape: um banco lento não pode segurar o scraper. */
export const LAG_QUERY_TIMEOUT_MS = 2_000;

const OUTBOX_LAG = 'outbox_lag_seconds';

/**
 * `GET /metrics` no formato texto do Prometheus (ARCHITECTURE 11.4). Sem AuthGuard (CLAUDE.md, "Autenticação"):
 * não deve ser exposto publicamente. As métricas são por instância; o scraper identifica a instância pelo rótulo
 * do próprio scrape.
 *
 * O `outbox_lag_seconds` é calculado AQUI, contra o banco, a cada scrape: um gauge guardado pelo publisher ficaria
 * velho se o laço parasse (ou se esta instância não publicar). Se o banco não responde, a métrica é OMITIDA (um
 * valor velho esconderia o problema) e `metrics_scrape_degraded_total` sobe; o resto do scrape continua.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Header('Content-Type', PROMETHEUS_CONTENT_TYPE)
  async scrape(): Promise<string> {
    if (!(this.metrics instanceof InMemoryMetrics)) throw new Error('GET /metrics needs the in-memory metrics registry');
    const lag = await this.outboxLagSeconds();
    if (lag === undefined) this.metrics.increment('metrics_scrape_degraded_total', { source: 'outbox_lag' });
    const body = renderPrometheus(this.metrics.families(), { exclude: new Set([OUTBOX_LAG]) });
    return lag === undefined ? body : `${body}${renderGauge(OUTBOX_LAG, lag)}`;
  }

  private async outboxLagSeconds(): Promise<number | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const oldest = await Promise.race([
        this.unitOfWork.run(({ outbox }) => outbox.oldestPendingOccurredAt()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lag query timeout')), LAG_QUERY_TIMEOUT_MS); }),
      ]);
      return oldest === undefined ? 0 : Math.max(0, (this.clock.now().getTime() - oldest.getTime()) / 1000);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
