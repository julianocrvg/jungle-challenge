/** Funções puras do teste de carga (sem rede, sem relógio): percentis, agregação e deltas de métricas Prometheus. */
import type { ParsedFamily } from '../../test/support/prometheus-parser';

/** Percentil por posto mais próximo (nearest-rank) sobre lista JÁ ordenada. Lista vazia: null. */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1]!;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function minMedMax(values: readonly number[]): { min: number; median: number; max: number } | null {
  if (values.length === 0) return null;
  return { min: Math.min(...values), median: median(values)!, max: Math.max(...values) };
}

export interface Series {
  name: string;
  labels: Record<string, string>;
  value: number;
  type: ParsedFamily['type'];
}

export const seriesKey = (name: string, labels: Record<string, string>): string =>
  `${name}{${Object.keys(labels).sort().map((k) => `${k}="${labels[k]}"`).join(',')}}`;

export function flatten(families: Map<string, ParsedFamily>): Series[] {
  const out: Series[] = [];
  for (const family of families.values()) {
    for (const s of family.samples) out.push({ name: s.name, labels: s.labels, value: s.value, type: family.type });
  }
  return out;
}

/** Várias instâncias → uma visão: counters e buckets SOMAM, gauges usam MAX (outbox_lag_seconds é global, ARCHITECTURE 11.4). */
export function aggregateInstances(snapshots: readonly (readonly Series[])[]): Map<string, Series> {
  const merged = new Map<string, Series>();
  for (const snapshot of snapshots) {
    for (const s of snapshot) {
      const key = seriesKey(s.name, s.labels);
      const current = merged.get(key);
      if (current === undefined) merged.set(key, { ...s });
      else current.value = s.type === 'gauge' ? Math.max(current.value, s.value) : current.value + s.value;
    }
  }
  return merged;
}

export interface Deltas {
  /** after − before por série (counters e buckets; gauges não entram). */
  deltas: Map<string, Series>;
  /** Séries que diminuíram (instância reiniciada durante a medição): o delta não é confiável. */
  resets: string[];
}

export function counterDeltas(before: ReadonlyMap<string, Series>, after: ReadonlyMap<string, Series>): Deltas {
  const deltas = new Map<string, Series>();
  const resets: string[] = [];
  for (const [key, s] of after) {
    if (s.type === 'gauge') continue;
    const previous = before.get(key)?.value ?? 0;
    if (s.value < previous) resets.push(key);
    deltas.set(key, { ...s, value: s.value - previous });
  }
  return { deltas, resets };
}

/** Soma o delta das séries de `name` cujos rótulos contêm todos os de `match`. */
export function sumDelta(deltas: ReadonlyMap<string, Series>, name: string, match: Record<string, string> = {}): number {
  let total = 0;
  for (const s of deltas.values()) {
    if (s.name !== name) continue;
    if (Object.entries(match).every(([k, v]) => s.labels[k] === v)) total += s.value;
  }
  return total;
}

/** Soma o delta por valor de um rótulo (ex.: db_lock_conflicts_total por sqlstate). */
export function sumDeltaBy(deltas: ReadonlyMap<string, Series>, name: string, label: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of deltas.values()) {
    if (s.name !== name) continue;
    const key = s.labels[label] ?? '';
    out[key] = (out[key] ?? 0) + s.value;
  }
  return out;
}

export interface Bucket {
  le: number;
  count: number;
}

/** Buckets cumulativos do delta de um histograma, somados entre rótulos (status etc.), ordenados por `le`. */
export function histogramBuckets(deltas: ReadonlyMap<string, Series>, family: string, match: Record<string, string>): Bucket[] {
  const byLe = new Map<number, number>();
  for (const s of deltas.values()) {
    if (s.name !== `${family}_bucket`) continue;
    if (!Object.entries(match).every(([k, v]) => s.labels[k] === v)) continue;
    // limite de bucket em segundos (latência), não dinheiro
    const le = s.labels.le === '+Inf' ? Infinity : Number.parseFloat(s.labels.le ?? 'NaN');
    byLe.set(le, (byLe.get(le) ?? 0) + s.value);
  }
  return [...byLe.entries()].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le);
}

/** Quantil (0..1) de buckets cumulativos, com interpolação linear dentro do bucket. Sem amostras: null. */
export function bucketQuantile(q: number, buckets: readonly Bucket[]): number | null {
  if (buckets.length === 0) return null;
  const total = buckets[buckets.length - 1]!.count;
  if (total <= 0) return null;
  const target = q * total;
  let lowerBound = 0;
  let lowerCount = 0;
  for (const b of buckets) {
    if (b.count >= target) {
      if (b.le === Infinity) return lowerBound; // cauda além do último bucket finito: devolve o último limite conhecido
      const inBucket = b.count - lowerCount;
      if (inBucket <= 0) return b.le;
      return lowerBound + ((b.le - lowerBound) * (target - lowerCount)) / inBucket;
    }
    lowerBound = b.le;
    lowerCount = b.count;
  }
  return lowerBound;
}

/** Conta respostas por código: 200, 202, 409, 422, 503, "other" e "network" (timeout/erro de rede, status null). */
export function tallyStatuses(statuses: readonly (number | null)[]): Record<string, number> {
  const out: Record<string, number> = { '200': 0, '202': 0, '409': 0, '422': 0, '503': 0, other: 0, network: 0 };
  for (const s of statuses) {
    const key = s === null ? 'network' : String(s) in out ? String(s) : 'other';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export const round1 = (x: number): number => Math.round(x * 10) / 10;
