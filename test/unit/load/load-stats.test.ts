import { describe, expect, test } from 'bun:test';
import { amountFromCents, centsFromAmount } from '../../../scripts/load/cents';
import {
  aggregateInstances, bucketQuantile, counterDeltas, flatten, histogramBuckets, minMedMax, percentile, summarizeLatencies,
  sumDelta, sumDeltaBy, tallyStatuses,
} from '../../../scripts/load/stats';
import { parsePrometheus } from '../../support/prometheus-parser';

const exposition = (lag: number, ok: number, conflicts: number): string => `# HELP wager_transactions_total t
# TYPE wager_transactions_total counter
wager_transactions_total{status="PROCESSED",kind="BET"} ${ok}
wager_transactions_total{status="REJECTED",kind="BET"} 1
# HELP db_lock_conflicts_total c
# TYPE db_lock_conflicts_total counter
db_lock_conflicts_total{sqlstate="55P03"} ${conflicts}
# HELP outbox_lag_seconds l
# TYPE outbox_lag_seconds gauge
outbox_lag_seconds ${lag}
# HELP http_request_duration_seconds h
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{route="/x",le="0.01"} ${ok}
http_request_duration_seconds_bucket{route="/x",le="0.1"} ${ok * 2}
http_request_duration_seconds_bucket{route="/x",le="+Inf"} ${ok * 2}
http_request_duration_seconds_sum{route="/x"} 1
http_request_duration_seconds_count{route="/x"} ${ok * 2}
`;

const snap = (text: string) => flatten(parsePrometheus(text));

describe('percentile', () => {
  test('lista vazia devolve null', () => {
    expect(percentile([], 50)).toBeNull();
    expect(summarizeLatencies([])).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null });
  });
  test('um elemento é todos os percentis', () => {
    expect(summarizeLatencies([7])).toEqual({ count: 1, p50: 7, p95: 7, p99: 7, max: 7 });
  });
  test('posto mais próximo em 1..100', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
  });
  test('ordena uma cópia sem alterar a entrada', () => {
    const input = [3, 1, 2];
    expect(summarizeLatencies(input).p50).toBe(2);
    expect(input).toEqual([3, 1, 2]);
  });
  test('min/mediana/máx', () => {
    expect(minMedMax([])).toBeNull();
    expect(minMedMax([5, 1, 3])).toEqual({ min: 1, median: 3, max: 5 });
    expect(minMedMax([1, 2, 3, 4])).toEqual({ min: 1, median: 2.5, max: 4 });
  });
});

describe('agregação e deltas de métricas', () => {
  test('counters somam entre instâncias e o gauge usa max', () => {
    const merged = aggregateInstances([snap(exposition(2, 10, 1)), snap(exposition(5, 20, 3))]);
    const deltas = counterDeltas(new Map(), merged).deltas;
    expect(sumDelta(deltas, 'wager_transactions_total', { status: 'PROCESSED' })).toBe(30);
    expect(sumDelta(deltas, 'db_lock_conflicts_total')).toBe(4);
    expect([...merged.values()].find((s) => s.name === 'outbox_lag_seconds')?.value).toBe(5);
  });

  test('delta = depois − antes, por série; gauge fica de fora', () => {
    const before = aggregateInstances([snap(exposition(1, 10, 1))]);
    const after = aggregateInstances([snap(exposition(9, 25, 4))]);
    const { deltas, resets } = counterDeltas(before, after);
    expect(resets).toEqual([]);
    expect(sumDelta(deltas, 'wager_transactions_total', { status: 'PROCESSED' })).toBe(15);
    expect(sumDeltaBy(deltas, 'db_lock_conflicts_total', 'sqlstate')).toEqual({ '55P03': 3 });
    expect(sumDelta(deltas, 'outbox_lag_seconds')).toBe(0);
  });

  test('série que diminui é reportada como reset', () => {
    const before = aggregateInstances([snap(exposition(0, 50, 0))]);
    const after = aggregateInstances([snap(exposition(0, 10, 0))]);
    expect(counterDeltas(before, after).resets.length).toBeGreaterThan(0);
  });

  test('série nova (ausente antes) conta do zero', () => {
    const after = aggregateInstances([snap(exposition(0, 7, 2))]);
    expect(sumDelta(counterDeltas(new Map(), after).deltas, 'db_lock_conflicts_total')).toBe(2);
  });

  test('quantil de histograma interpola no bucket; sem amostras é null', () => {
    const merged = aggregateInstances([snap(exposition(0, 10, 0))]);
    const buckets = histogramBuckets(counterDeltas(new Map(), merged).deltas, 'http_request_duration_seconds', { route: '/x' });
    expect(buckets.map((b) => b.le)).toEqual([0.01, 0.1, Infinity]);
    expect(bucketQuantile(0.25, buckets)).toBeCloseTo(0.005, 6); // metade do primeiro bucket (10 de 20 amostras)
    expect(bucketQuantile(0.75, buckets)).toBeCloseTo(0.055, 6);
    expect(bucketQuantile(0.5, [])).toBeNull();
    expect(bucketQuantile(0.5, [{ le: 1, count: 0 }])).toBeNull();
  });
});

describe('contagem por status e dinheiro em centavos', () => {
  test('separa 503, outros e erros de rede', () => {
    expect(tallyStatuses([200, 200, 202, 409, 422, 503, 400, 500, null, null])).toEqual({
      '200': 2, '202': 1, '409': 1, '422': 1, '503': 1, other: 2, network: 2,
    });
  });
  test('centavos ida e volta, sem number', () => {
    expect(centsFromAmount('1.00')).toBe(100n);
    expect(centsFromAmount('10000000.00')).toBe(1_000_000_000n);
    expect(amountFromCents(5n)).toBe('0.05');
    expect(amountFromCents(123456789012345678n)).toBe('1234567890123456.78');
    expect(() => centsFromAmount('1.5')).toThrow();
    expect(() => centsFromAmount('01.00')).toThrow();
  });
});
