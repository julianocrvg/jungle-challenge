import type { MetricLabels } from '../../application/ports/metrics';
import type { MetricFamily } from './in-memory-metrics';

/** Content-Type do formato texto do Prometheus. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Descrições (HELP) das métricas que os alertas usam. Famílias sem entrada saem sem HELP. */
const HELP: Record<string, string> = {
  http_requests_total: 'HTTP requests finished, by method, route template and status (499 = client aborted).',
  http_request_duration_seconds: 'HTTP request duration in seconds, by method, route template and status.',
  wager_transactions_total: 'Wager transactions that changed status (new PROCESSED, REJECTED, PENDING_REFERENCE), including those resolved by the pending-reference worker. Replays are not counted.',
  wager_rejections_total: 'Wager transactions rejected by a business rule, by failure code.',
  wager_duplicates_total: 'Duplicates detected: same Idempotency-Key and payload (level=idempotency_key) or same SQS messageId (level=inbox).',
  wager_idempotency_conflicts_total: 'Requests refused with 409: same key or external id with a different payload.',
  db_lock_conflicts_total: 'Database lock conflicts, by SQLSTATE (55P03 lock_timeout, 40P01 deadlock).',
  outbox_lag_seconds: 'Age of the oldest unpublished outbox row. Global (same value on every instance): aggregate with max, not sum.',
  outbox_published_total: 'Outbox events published.',
  outbox_retries_total: 'Outbox events scheduled for retry.',
  sqs_consumer_processing_seconds: 'Time to process one wager SQS message, in seconds.',
  sqs_consumer_messages_total: 'Wager SQS messages processed, by outcome.',
  sqs_consumer_retries_total: 'Wager SQS messages left for redelivery, by reason.',
  sqs_consumer_dlq_total: 'Wager SQS messages moved to the dead-letter queue, by reason.',
  pending_reference_retries_total: 'PENDING_REFERENCE retries scheduled.',
  metrics_scrape_degraded_total: 'Scrapes that omitted a metric because its source was unavailable.',
};


const escapeHelp = (text: string): string => text.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
export const escapeLabelValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

function labelSet(labels: MetricLabels, extra?: [string, string]): string {
  const pairs = Object.keys(labels).sort().map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`);
  if (extra !== undefined) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

/**
 * Formato texto do Prometheus (versão 0.0.4). Uma família por vez: `# HELP`, `# TYPE` (uma única vez) e as
 * amostras. Histograma: buckets cumulativos em ordem crescente de `le`, o último `+Inf` igual a `_count`, mais
 * `_sum` e `_count`. Valores de label escapam `\`, `"` e quebra de linha.
 */
export function renderPrometheus(families: readonly MetricFamily[], options: { exclude?: ReadonlySet<string> } = {}): string {
  const lines: string[] = [];
  for (const family of families) {
    if (options.exclude?.has(family.name) === true) continue;
    const help = HELP[family.name];
    if (help !== undefined) lines.push(`# HELP ${family.name} ${escapeHelp(help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    const series = [...family.series].sort((a, b) => labelSet(a.labels).localeCompare(labelSet(b.labels)));
    for (const s of series) {
      if (family.type === 'histogram') {
        const h = s as typeof family.series[number];
        family.bounds.forEach((bound, i) => {
          lines.push(`${family.name}_bucket${labelSet(h.labels, ['le', String(bound)])} ${h.buckets[i]}`);
        });
        lines.push(`${family.name}_bucket${labelSet(h.labels, ['le', '+Inf'])} ${h.count}`);
        lines.push(`${family.name}_sum${labelSet(h.labels)} ${formatNumber(h.sum)}`);
        lines.push(`${family.name}_count${labelSet(h.labels)} ${h.count}`);
      } else {
        lines.push(`${family.name}${labelSet(s.labels)} ${formatNumber((s as { value: number }).value)}`);
      }
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Uma amostra extra (por exemplo, um gauge calculado no scrape), no mesmo formato. */
export function renderGauge(name: string, value: number): string {
  const help = HELP[name];
  return `${help === undefined ? '' : `# HELP ${name} ${escapeHelp(help)}\n`}# TYPE ${name} gauge\n${name} ${formatNumber(value)}\n`;
}
