import type { MetricLabels, Metrics } from '../../application/ports/metrics';

/** Registro em memória, por instância. A exposição em `/metrics` entra na fatia de observabilidade. */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  counter(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(metricKey(name, labels)) ?? 0;
  }

  gaugeValue(name: string, labels: MetricLabels = {}): number | undefined {
    return this.gauges.get(metricKey(name, labels));
  }
}

function metricKey(name: string, labels: MetricLabels): string {
  const pairs = Object.keys(labels).sort().map((key) => `${key}="${labels[key]}"`);
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`;
}
