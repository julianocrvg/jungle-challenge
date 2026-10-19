import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { Clock } from '../../application/ports/clock';
import { CLOCK } from '../../application/ports/clock';
import { METRICS, type Metrics } from '../../application/ports/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports/unit-of-work';
import { InMemoryMetrics } from '../../infrastructure/metrics/in-memory-metrics';
import { PROMETHEUS_CONTENT_TYPE, renderGauge, renderPrometheus } from '../../infrastructure/metrics/prometheus';

/**
 * Teto do cálculo do lag no scrape: um banco lento não pode segurar o scraper. Vale duas vezes: `statement_timeout`
 * no banco (a conexão volta ao pool) e `Promise.race` na aplicação (cobre também a espera por uma conexão do pool).
 */
export const LAG_QUERY_TIMEOUT_MS = 2_000;
/** Por quanto tempo uma leitura do lag (ou a falha dela) é reaproveitada entre scrapes. */
export const LAG_CACHE_TTL_MS = 5_000;

const OUTBOX_LAG = 'outbox_lag_seconds';

/** `oldest` ausente: nenhuma pendente. `ok: false`: o banco não respondeu dentro do teto. */
type LagReading = { ok: true; oldest: Date | undefined } | { ok: false };

/**
 * `GET /metrics` no formato texto do Prometheus (ARCHITECTURE 11.4). Sem AuthGuard (CLAUDE.md, "Autenticação"):
 * não deve ser exposto publicamente. As métricas são por instância; o scraper identifica a instância pelo rótulo
 * do próprio scrape.
 *
 * O `outbox_lag_seconds` é calculado AQUI, contra o banco: um gauge guardado pelo publisher ficaria velho se o laço
 * parasse (ou se esta instância não publicar). A leitura (a linha pendente mais antiga) fica em cache por 5 s e
 * scrapes simultâneos dividem a mesma consulta: o scrape não compete com o tráfego de negócio pelo pool. O lag em si
 * é `now − oldest` no momento do scrape, então continua andando entre leituras. Se o banco não responde, a métrica é
 * OMITIDA (um valor velho esconderia o problema) e `metrics_scrape_degraded_total` sobe uma vez por consulta real.
 */
@Controller('metrics')
export class MetricsController {
  private cached: { reading: LagReading; readAtMs: number } | undefined;
  private inFlight: Promise<LagReading> | undefined;

  constructor(
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Header('Content-Type', PROMETHEUS_CONTENT_TYPE)
  async scrape(): Promise<string> {
    if (!(this.metrics instanceof InMemoryMetrics)) throw new Error('GET /metrics needs the in-memory metrics registry');
    const reading = await this.lagReading();
    const body = renderPrometheus(this.metrics.families(), { exclude: new Set([OUTBOX_LAG]) });
    if (!reading.ok) return body;
    const lag = reading.oldest === undefined ? 0 : Math.max(0, (this.clock.now().getTime() - reading.oldest.getTime()) / 1000);
    return `${body}${renderGauge(OUTBOX_LAG, lag)}`;
  }

  private lagReading(): Promise<LagReading> {
    const cached = this.cached;
    if (cached !== undefined && this.clock.now().getTime() - cached.readAtMs < LAG_CACHE_TTL_MS) {
      return Promise.resolve(cached.reading);
    }
    // Single-flight: quem chega com uma consulta em andamento espera a mesma; limpa no fim, com sucesso ou erro.
    this.inFlight ??= this.readLag().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async readLag(): Promise<LagReading> {
    const readAtMs = this.clock.now().getTime();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: LagReading;
    try {
      const oldest = await Promise.race([
        this.unitOfWork.run(({ outbox }) => outbox.oldestPendingOccurredAt(), { statementTimeoutMs: LAG_QUERY_TIMEOUT_MS }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lag query timeout')), LAG_QUERY_TIMEOUT_MS); }),
      ]);
      reading = { ok: true, oldest };
    } catch {
      this.metrics.increment('metrics_scrape_degraded_total', { source: 'outbox_lag' });
      reading = { ok: false };
    } finally {
      clearTimeout(timer);
    }
    this.cached = { reading, readAtMs };
    return reading;
  }
}
