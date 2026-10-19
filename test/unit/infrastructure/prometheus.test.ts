import { describe, expect, test } from 'bun:test';
import { DEFAULT_BUCKETS, InMemoryMetrics } from '../../../src/infrastructure/metrics/in-memory-metrics';
import { renderGauge, renderPrometheus } from '../../../src/infrastructure/metrics/prometheus';
import { parsePrometheus, sampleValue, sumWhere } from '../../support/prometheus-parser';

/*
 * Exposição Prometheus (ARCHITECTURE 11.4) conferida por um parser ESTRITO: TYPE uma vez por família, buckets
 * cumulativos, +Inf igual a _count, _sum/_count e escape de label.
 */

const render = (metrics: InMemoryMetrics): string => renderPrometheus(metrics.families());

describe('renderPrometheus', () => {
  test('contador, gauge e histograma passam pelo parser estrito, com TYPE uma vez por família', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('wager_transactions_total', { status: 'PROCESSED', kind: 'BET' }, 3);
    metrics.increment('wager_transactions_total', { status: 'REJECTED', kind: 'BET' });
    metrics.increment('wager_transactions_total', { status: 'PROCESSED', kind: 'WIN' });
    metrics.gauge('pending_reference_pending', 7);
    metrics.observe('http_request_duration_seconds', 0.02, { method: 'GET', route: '/x', status: '200' });
    metrics.observe('http_request_duration_seconds', 0.3, { method: 'GET', route: '/x', status: '200' });
    metrics.observe('http_request_duration_seconds', 0.3, { method: 'POST', route: '/x', status: '201' });

    const text = render(metrics);
    const families = parsePrometheus(text);
    expect([...families.keys()].sort()).toEqual(['http_request_duration_seconds', 'pending_reference_pending', 'wager_transactions_total']);
    expect(text.match(/^# TYPE wager_transactions_total counter$/gm)).toHaveLength(1);
    expect(text.match(/^# TYPE http_request_duration_seconds histogram$/gm)).toHaveLength(1);
    expect(sampleValue(families, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(3);
    expect(sumWhere(families, 'wager_transactions_total', { status: 'PROCESSED' })).toBe(4);
    expect(sampleValue(families, 'pending_reference_pending')).toBe(7);
    expect(families.get('wager_transactions_total')?.help).toContain('Wager transactions');
  });

  test('histograma: buckets cumulativos, nas bordas, com +Inf = _count e _sum', () => {
    const metrics = new InMemoryMetrics();
    const labels = { route: '/r' };
    // Abaixo do primeiro limite, exatamente em um limite, entre dois e acima do último.
    for (const value of [0.001, 0.005, 0.03, 0.03, 10, 11]) metrics.observe('lat_seconds', value, labels);
    const families = parsePrometheus(render(metrics));
    const le = (bound: string): number => sampleValue(families, 'lat_seconds_bucket', { route: '/r', le: bound })!;
    expect(le('0.005')).toBe(2); // 0.001 e 0.005 (<=)
    expect(le('0.025')).toBe(2);
    expect(le('0.05')).toBe(4);
    expect(le('10')).toBe(5);
    expect(le('+Inf')).toBe(6);
    expect(sampleValue(families, 'lat_seconds_count', labels)).toBe(6);
    expect(sampleValue(families, 'lat_seconds_sum', labels)).toBeCloseTo(21.066, 6);
    expect(DEFAULT_BUCKETS.map(String).every((b) => sampleValue(families, 'lat_seconds_bucket', { route: '/r', le: b }) !== undefined)).toBe(true);
  });

  test('histograma sem observações em uma série não existe; duas séries ficam independentes', () => {
    const metrics = new InMemoryMetrics();
    metrics.observe('a_seconds', 1, { k: 'x' });
    metrics.observe('a_seconds', 1, { k: 'y' });
    metrics.observe('a_seconds', 1, { k: 'y' });
    const families = parsePrometheus(render(metrics));
    expect(sampleValue(families, 'a_seconds_count', { k: 'x' })).toBe(1);
    expect(sampleValue(families, 'a_seconds_count', { k: 'y' })).toBe(2);
  });

  test('escape de label: aspas, barra invertida e quebra de linha fazem o ida e volta', () => {
    const metrics = new InMemoryMetrics();
    const nasty = 'a"b\\c\nd';
    metrics.increment('weird_total', { route: nasty });
    const text = render(metrics);
    expect(text).toContain('route="a\\"b\\\\c\\nd"');
    expect(text.split('\n').length).toBe(3); // TYPE, amostra e o vazio depois do \n final: o \n do valor não quebra a linha
    const families = parsePrometheus(text);
    expect(families.get('weird_total')?.samples[0]?.labels.route).toBe(nasty);
  });

  test('exclude omite uma família; renderGauge acrescenta uma amostra com HELP', () => {
    const metrics = new InMemoryMetrics();
    metrics.gauge('outbox_lag_seconds', 99);
    metrics.increment('x_total');
    const text = renderPrometheus(metrics.families(), { exclude: new Set(['outbox_lag_seconds']) }) + renderGauge('outbox_lag_seconds', 1.5);
    const families = parsePrometheus(text);
    expect(sampleValue(families, 'outbox_lag_seconds')).toBe(1.5);
    expect(families.get('outbox_lag_seconds')?.help).toContain('max, not sum');
  });

  test('sem métricas, o corpo é vazio (e válido)', () => {
    expect(render(new InMemoryMetrics())).toBe('');
    expect(parsePrometheus('').size).toBe(0);
  });

  test('um mesmo nome com dois tipos é um bug e lança', () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('dup_total');
    expect(() => metrics.gauge('dup_total', 1)).toThrow(/is a counter, not a gauge/);
    expect(() => metrics.observe('dup_total', 1)).toThrow(/is a counter, not a histogram/);
  });
});

describe('o parser estrito rejeita exposições inválidas', () => {
  test.each([
    ['TYPE duplicado', '# TYPE a_total counter\na_total 1\n# TYPE a_total counter\n'],
    ['amostra antes do TYPE', 'a_total 1\n# TYPE a_total counter\n'],
    ['contador sem _total', '# TYPE a counter\na 1\n'],
    ['família que volta', '# TYPE a_total counter\na_total{x="1"} 1\n# TYPE b_total counter\nb_total 1\na_total{x="2"} 1\n'],
    ['série repetida', '# TYPE a_total counter\na_total{x="1"} 1\na_total{x="1"} 2\n'],
    ['escape inválido', '# TYPE a_total counter\na_total{x="\\q"} 1\n'],
    ['aspas não escapadas', '# TYPE a_total counter\na_total{x="a"b"} 1\n'],
    ['label duplicado', '# TYPE a_total counter\na_total{x="1",x="2"} 1\n'],
    ['vírgula sobrando', '# TYPE a_total counter\na_total{x="1",} 1\n'],
    ['sem quebra de linha final', '# TYPE a_total counter\na_total 1'],
    ['linha em branco', '# TYPE a_total counter\n\na_total 1\n'],
    ['contador negativo', '# TYPE a_total counter\na_total -1\n'],
    ['valor inválido', '# TYPE a_total counter\na_total abc\n'],
    ['histograma sem +Inf', '# TYPE h histogram\nh_bucket{le="1"} 1\nh_sum 1\nh_count 1\n'],
    ['histograma não cumulativo', '# TYPE h histogram\nh_bucket{le="1"} 2\nh_bucket{le="2"} 1\nh_bucket{le="+Inf"} 2\nh_sum 1\nh_count 2\n'],
    ['+Inf diferente de _count', '# TYPE h histogram\nh_bucket{le="1"} 1\nh_bucket{le="+Inf"} 1\nh_sum 1\nh_count 2\n'],
    ['le fora de ordem', '# TYPE h histogram\nh_bucket{le="2"} 1\nh_bucket{le="1"} 1\nh_bucket{le="+Inf"} 1\nh_sum 1\nh_count 1\n'],
    ['histograma sem _sum', '# TYPE h histogram\nh_bucket{le="+Inf"} 1\nh_count 1\n'],
    ['le num gauge', '# TYPE g gauge\ng{le="1"} 1\n'],
    ['comentário desconhecido', '# whatever\n'],
  ])('%s', (_name, text) => {
    expect(() => parsePrometheus(text)).toThrow();
  });
});
