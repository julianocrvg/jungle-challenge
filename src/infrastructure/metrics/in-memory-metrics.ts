import type { MetricLabels, Metrics } from '../../application/ports/metrics';

/** Contagem, soma e máximo das observações de um histograma. */
export interface Summary {
  count: number;
  sum: number;
  max: number;
}

/** Limites (em segundos) dos histogramas de latência: de 5 ms a 10 s. O último, `+Inf`, é implícito. */
export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface CounterSeries { labels: MetricLabels; value: number }
export interface GaugeSeries { labels: MetricLabels; value: number }
export interface HistogramSeries {
  labels: MetricLabels;
  /** Contagem **cumulativa** por limite de `DEFAULT_BUCKETS` (observações <= limite). */
  buckets: readonly number[];
  count: number;
  sum: number;
}
export type MetricFamily =
  | { name: string; type: 'counter'; series: CounterSeries[] }
  | { name: string; type: 'gauge'; series: GaugeSeries[] }
  | { name: string; type: 'histogram'; bounds: readonly number[]; series: HistogramSeries[] };

interface Entry<T> { name: string; labels: MetricLabels; data: T }
interface HistogramData { perBucket: number[]; count: number; sum: number; max: number }

/**
 * Registro em memória, por instância (ARCHITECTURE 11.4). Cada nome pertence a um único tipo (counter, gauge ou
 * histogram); usar o mesmo nome com dois tipos é um bug de programação e lança.
 */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, Entry<{ value: number }>>();
  private readonly gauges = new Map<string, Entry<{ value: number }>>();
  private readonly histograms = new Map<string, Entry<HistogramData>>();
  private readonly types = new Map<string, MetricType>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    this.claim(name, 'counter');
    const key = metricKey(name, labels);
    const entry = this.counters.get(key) ?? { name, labels, data: { value: 0 } };
    entry.data.value += value;
    this.counters.set(key, entry);
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.claim(name, 'gauge');
    this.gauges.set(metricKey(name, labels), { name, labels, data: { value } });
  }

  observe(name: string, value: number, labels: MetricLabels = {}): void {
    this.claim(name, 'histogram');
    const key = metricKey(name, labels);
    const entry = this.histograms.get(key) ?? {
      name, labels, data: { perBucket: new Array<number>(DEFAULT_BUCKETS.length).fill(0), count: 0, sum: 0, max: 0 },
    };
    const index = DEFAULT_BUCKETS.findIndex((bound) => value <= bound);
    if (index !== -1) entry.data.perBucket[index]!++;
    entry.data.count++;
    entry.data.sum += value;
    entry.data.max = Math.max(entry.data.max, value);
    this.histograms.set(key, entry);
  }

  summary(name: string, labels: MetricLabels = {}): Summary | undefined {
    const data = this.histograms.get(metricKey(name, labels))?.data;
    return data === undefined ? undefined : { count: data.count, sum: data.sum, max: data.max };
  }

  counter(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(metricKey(name, labels))?.data.value ?? 0;
  }

  /** Todos os contadores, pela chave `nome{label="valor"}`. */
  counterSnapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters].map(([key, entry]) => [key, entry.data.value]));
  }

  gaugeValue(name: string, labels: MetricLabels = {}): number | undefined {
    return this.gauges.get(metricKey(name, labels))?.data.value;
  }

  /** As famílias registradas, ordenadas por nome, para a exposição. */
  families(): MetricFamily[] {
    const families = new Map<string, MetricFamily>();
    const family = (name: string, type: MetricType): MetricFamily => {
      const existing = families.get(name);
      if (existing !== undefined) return existing;
      const created: MetricFamily =
        type === 'histogram' ? { name, type, bounds: DEFAULT_BUCKETS, series: [] } : { name, type, series: [] };
      families.set(name, created);
      return created;
    };
    for (const e of this.counters.values()) (family(e.name, 'counter').series as CounterSeries[]).push({ labels: e.labels, value: e.data.value });
    for (const e of this.gauges.values()) (family(e.name, 'gauge').series as GaugeSeries[]).push({ labels: e.labels, value: e.data.value });
    for (const e of this.histograms.values()) {
      let running = 0;
      const buckets = e.data.perBucket.map((n) => (running += n));
      (family(e.name, 'histogram').series as HistogramSeries[]).push({ labels: e.labels, buckets, count: e.data.count, sum: e.data.sum });
    }
    return [...families.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private claim(name: string, type: MetricType): void {
    const existing = this.types.get(name);
    if (existing === undefined) this.types.set(name, type);
    else if (existing !== type) throw new Error(`Metric ${name} is a ${existing}, not a ${type}`);
  }
}

function metricKey(name: string, labels: MetricLabels): string {
  const pairs = Object.keys(labels).sort().map((key) => `${key}="${labels[key]}"`);
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`;
}
