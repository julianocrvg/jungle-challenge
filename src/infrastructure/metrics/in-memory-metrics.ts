import type { MetricLabels, Metrics } from '../../application/ports/metrics';

/** Contagem, soma e máximo das observações (base de um histograma na fatia 9). */
export interface Summary {
  count: number;
  sum: number;
  max: number;
}

/** Registro em memória, por instância. A exposição em `/metrics` entra na fatia de observabilidade. */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly summaries = new Map<string, Summary>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    const key = metricKey(name, labels);
    const current = this.summaries.get(key) ?? { count: 0, sum: 0, max: 0 };
    this.summaries.set(key, { count: current.count + 1, sum: current.sum + value, max: Math.max(current.max, value) });
  }

  summary(name: string, labels: MetricLabels = {}): Summary | undefined {
    return this.summaries.get(metricKey(name, labels));
  }

  counter(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(metricKey(name, labels)) ?? 0;
  }

  /** Todos os contadores, pela chave `nome{label="valor"}`. */
  counterSnapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  gaugeValue(name: string, labels: MetricLabels = {}): number | undefined {
    return this.gauges.get(metricKey(name, labels));
  }
}

function metricKey(name: string, labels: MetricLabels): string {
  const pairs = Object.keys(labels).sort().map((key) => `${key}="${labels[key]}"`);
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`;
}
