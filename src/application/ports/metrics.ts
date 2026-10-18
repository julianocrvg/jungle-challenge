export type MetricLabels = Readonly<Record<string, string>>;

/** Porta de métricas. A exposição (formato e endpoint) fica para a fatia de observabilidade. */
export interface Metrics {
  increment(name: string, labels?: MetricLabels, value?: number): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
}

export const METRICS = Symbol('Metrics');
