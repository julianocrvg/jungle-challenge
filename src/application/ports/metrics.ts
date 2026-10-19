export type MetricLabels = Readonly<Record<string, string>>;

/** Porta de métricas. O registro em memória e o formato Prometheus ficam na infraestrutura (ARCHITECTURE 11.4). */
export interface Metrics {
  increment(name: string, labels?: MetricLabels, value?: number): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  /** Uma observação de distribuição (latência, em segundos). */
  observe(name: string, value: number, labels?: MetricLabels): void;
}

export const METRICS = Symbol('Metrics');

/** Para quem recebe `Metrics` como dependência opcional (use cases construídos sem registro). */
export const NOOP_METRICS: Metrics = {
  increment: () => {},
  gauge: () => {},
  observe: () => {},
};
