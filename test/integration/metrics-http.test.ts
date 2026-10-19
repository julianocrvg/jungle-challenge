import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ResolvePendingReference } from '../../src/application/wagering/resolve-pending-reference';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { PROMETHEUS_CONTENT_TYPE } from '../../src/infrastructure/metrics/prometheus';
import { LAG_CACHE_TTL_MS } from '../../src/interface/http/metrics.controller';
import { parsePrometheus, type ParsedFamily, sampleValue, sumWhere } from '../support/prometheus-parser';
import { createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload, type WalletBody } from './support/app';
import { holdWalletLock } from './support/consumer';
import { closedPort, createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { assertCaptureWired, MONETARY, monetaryLeaks } from './support/logs';
import { ManualClock, waitFor } from './support/outbox';

/*
 * GET /metrics (ARCHITECTURE 11.4) com Nest, Express e Postgres reais: exposição conferida por um parser estrito,
 * contagens exatas (cada teste sobe a sua aplicação, com registro zerado), labels limitados, 4xx e 422 contados,
 * requisição abortada contada uma vez, conflito de lock (55P03) e lag da outbox calculado no scrape.
 */

let orm: MikroORM;
let sql: Sql;
const apps: TestApp[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
}, 30_000);

afterAll(async () => {
  for (const app of apps) await app.close();
  await orm?.close(true);
});

afterEach(async () => {
  for (const app of apps) expect(monetaryLeaks(app.logger.entries)).toEqual([]);
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
});

async function start(options: Parameters<typeof startTestApp>[0] = {}): Promise<TestApp> {
  const app = await startTestApp(options);
  assertCaptureWired(app.logger);
  apps.push(app);
  return app;
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function scrape(app: TestApp): Promise<{ response: Response; text: string; families: Map<string, ParsedFamily> }> {
  const response = await fetch(`${app.baseUrl}/metrics`, { keepalive: false });
  const text = await response.text();
  return { response, text, families: parsePrometheus(text) };
}

/**
 * A regex de valor monetário dos logs (MONETARY) aplicada a todo texto que um label ou nome pode carregar: nome da
 * família, HELP, nome da série, nomes e valores de label. Ficam fora o `le` dos buckets (0.05, 0.25 são limites de
 * latência) e o valor numérico de cada amostra (um `_sum` de 0.01 s ou um lag de 5.25 s casariam com a regex). Lança
 * se não há amostras: um parser que não leu nada faria o teste passar em vazio.
 */
function exposedMonetaryText(families: Map<string, ParsedFamily>): string[] {
  const texts: string[] = [];
  let samples = 0;
  for (const family of families.values()) {
    texts.push(family.name, family.help ?? '');
    for (const sample of family.samples) {
      samples += 1;
      texts.push(sample.name);
      for (const [name, value] of Object.entries(sample.labels)) if (name !== 'le') texts.push(`${name}="${value}"`, JSON.stringify({ [name]: value }));
    }
  }
  if (samples === 0) throw new Error('no samples parsed: the monetary check would pass vacuously');
  return texts.filter((text) => MONETARY.test(text));
}

describe('varredura de valores monetários na exposição', () => {
  test('pega um label amount="100.00" (e um valor monetário em label de outro nome) e ignora le e valores de amostra', () => {
    const clean = parsePrometheus([
      '# HELP x_seconds Latency.', '# TYPE x_seconds histogram',
      'x_seconds_bucket{le="0.05"} 1', 'x_seconds_bucket{le="+Inf"} 1', 'x_seconds_sum 0.01', 'x_seconds_count 1',
      '# HELP lag Lag.', '# TYPE lag gauge', 'lag 5.25', '',
    ].join('\n'));
    expect(exposedMonetaryText(clean)).toEqual([]);
    const leaking = parsePrometheus(['# HELP c_total Count.', '# TYPE c_total counter', 'c_total{amount="100.00"} 1', 'c_total{status="25.00"} 1', ''].join('\n'));
    expect(exposedMonetaryText(leaking)).toEqual(['amount="100.00"', '{"amount":"100.00"}', 'status="25.00"', '{"status":"25.00"}']);
    expect(() => exposedMonetaryText(parsePrometheus(''))).toThrow('vacuously');
  });
});

describe('GET /metrics', () => {
  test('200, sem autenticação, Content-Type do Prometheus e exposição válida para o parser estrito', async () => {
    const app = await start();
    await createWalletViaApi(app, '100.00');
    const { response, text, families } = await scrape(app);
    expect(response.status).toBe(200);
    // O Express reordena os parâmetros (charset antes de version); o scraper não depende da ordem.
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType.split(';').map((part) => part.trim()).sort()).toEqual(PROMETHEUS_CONTENT_TYPE.split(';').map((part) => part.trim()).sort());
    expect(text.endsWith('\n')).toBe(true);
    expect(families.has('http_requests_total')).toBe(true);
    expect(exposedMonetaryText(families)).toEqual([]);
    // Cada família declara o TYPE uma única vez.
    for (const family of families.keys()) expect(text.match(new RegExp(`^# TYPE ${family} `, 'gm'))).toHaveLength(1);
  });

  test('transações por status, duplicatas, conflitos 409 e 422, com os códigos HTTP contados', async () => {
    const app = await start();
    const wallet = await createWalletViaApi(app, '100.00');
    const bet = wagerPayload(wallet, { money: brl('10.00') });
    expect((await submit(app, bet)).status).toBe(200); // PROCESSED
    expect((await submit(app, bet)).status).toBe(200); // replay: duplicata
    expect((await submit(app, bet)).status).toBe(200); // replay
    const conflict = await submit(app, { ...bet, money: brl('11.00') }, `${bet.providerId}:${bet.externalTransactionId}`);
    expect(conflict.status).toBe(409); // mesma chave, outro payload: NÃO é duplicata
    const rejected = await submit(app, wagerPayload(wallet, { money: brl('500.00') }));
    expect(rejected.status).toBe(422); // REJECTED INSUFFICIENT_FUNDS
    expect((await fetch(`${app.baseUrl}/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await app.post('/wagering/transactions', '{"amount":"1.00"', { 'idempotency-key': 'k' })).status).toBe(400);

    const { families } = await scrape(app);
    const tx = (status: string, kind: string) => sampleValue(families, 'wager_transactions_total', { status, kind }) ?? 0;
    expect(tx('PROCESSED', 'BET')).toBe(1); // as duas repetições não contam como transação nova
    expect(tx('REJECTED', 'BET')).toBe(1);
    expect(sampleValue(families, 'wager_rejections_total', { failure_code: 'INSUFFICIENT_FUNDS' })).toBe(1);
    expect(sampleValue(families, 'wager_duplicates_total', { source: 'http', level: 'idempotency_key' })).toBe(2);
    expect(sampleValue(families, 'wager_idempotency_conflicts_total', { kind: 'idempotency_key' })).toBe(1);
    expect(sumWhere(families, 'wager_duplicates_total', { source: 'sqs' })).toBe(0);

    const http = (method: string, route: string, status: string) =>
      sampleValue(families, 'http_requests_total', { method, route, status }) ?? 0;
    expect(http('POST', '/wallets', '201')).toBe(1);
    expect(http('POST', '/wagering/transactions', '200')).toBe(3);
    expect(http('POST', '/wagering/transactions', '409')).toBe(1);
    expect(http('POST', '/wagering/transactions', '422')).toBe(1);
    // JSON malformado morre no body-parser, antes de a rota casar: fica em "unmatched", ainda com o método e o 400.
    expect(http('POST', 'unmatched', '400')).toBe(1);
    expect(http('GET', '/wallets/:walletId', '404')).toBe(1);
  });

  test('o histograma de latência HTTP fecha com a contagem: +Inf = _count = http_requests_total, por série', async () => {
    const app = await start();
    const wallet = await createWalletViaApi(app, '100.00');
    await submit(app, wagerPayload(wallet, { money: brl('5.00') }));
    const { families } = await scrape(app);
    const counts = families.get('http_requests_total')!.samples;
    expect(counts.length).toBeGreaterThan(1);
    for (const sample of counts) {
      expect(sampleValue(families, 'http_request_duration_seconds_count', sample.labels)).toBe(sample.value);
      expect(sampleValue(families, 'http_request_duration_seconds_bucket', { ...sample.labels, le: '+Inf' })).toBe(sample.value);
    }
  });

  test('labels limitados: método conhecido, rota como template ou unmatched, status como código; nunca um id', async () => {
    const app = await start();
    const wallet = await createWalletViaApi(app, '100.00');
    const bet = wagerPayload(wallet, { money: brl('5.00') });
    await submit(app, bet);
    await fetch(`${app.baseUrl}/wallets/${wallet.id}/ledger`);
    for (let i = 0; i < 40; i++) await fetch(`${app.baseUrl}/nope/${Bun.randomUUIDv7()}/${i}`); // 40 URLs diferentes
    await fetch(`${app.baseUrl}/wallets`, { method: 'PURGE' });

    const { text, families } = await scrape(app);
    const series = families.get('http_requests_total')!.samples;
    expect(new Set(series.flatMap((s) => Object.keys(s.labels)))).toEqual(new Set(['method', 'route', 'status']));
    expect(series.every((s) => ['GET', 'POST', 'OTHER'].includes(s.labels.method!))).toBe(true);
    expect(series.every((s) => /^\d{3}$/.test(s.labels.status!))).toBe(true);
    // 40 URLs inexistentes viram UMA série.
    expect(series.filter((s) => s.labels.route === 'unmatched' && s.labels.method === 'GET')).toHaveLength(1);
    expect(sampleValue(families, 'http_requests_total', { method: 'GET', route: 'unmatched', status: '404' })).toBe(40);
    expect(series.some((s) => s.labels.method === 'OTHER')).toBe(true);
    for (const needle of [wallet.id, wallet.playerId, String(bet.externalTransactionId), 'provider-a']) {
      expect(text).not.toContain(needle);
    }
    expect(series.map((s) => s.labels.route).sort()).toEqual([...new Set(series.map((s) => s.labels.route))].sort().flatMap((r) =>
      series.filter((s) => s.labels.route === r).map(() => r)));
    expect(series.every((s) => s.labels.route === 'unmatched' || s.labels.route!.startsWith('/'))).toBe(true);
  });

  test('requisição abortada pelo cliente conta uma vez, como 499, e a resposta tardia não conta de novo', async () => {
    const app = await start();
    const wallet = await createWalletViaApi(app, '100.00');
    const lock = await holdWalletLock(orm, wallet.id);
    const controller = new AbortController();
    const payload = wagerPayload(wallet, { money: brl('5.00') });
    // A submissão fica bloqueada no FOR UPDATE da wallet; o cliente desiste antes da resposta.
    const pending = fetch(`${app.baseUrl}/wagering/transactions`, {
      method: 'POST', keepalive: false, signal: controller.signal,
      headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${payload.externalTransactionId}` },
      body: JSON.stringify(payload),
    }).catch((error: Error) => error.name);
    await Bun.sleep(300); // a requisição chegou ao servidor e está esperando o lock
    controller.abort();
    expect(await pending).toBe('AbortError');
    await waitFor(async () => {
      const { families } = await scrape(app);
      return sumWhere(families, 'http_requests_total', { route: '/wagering/transactions' });
    }, (n) => n === 1, 10_000);
    await lock.release(); // a transação do servidor termina depois, e o COMMIT acontece
    await waitFor(async () => (await sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET'`, [wallet.id]))[0]?.n, (n) => n === 1, 10_000);

    const { families } = await scrape(app);
    expect(sampleValue(families, 'http_requests_total', { method: 'POST', route: '/wagering/transactions', status: '499' })).toBe(1);
    expect(sumWhere(families, 'http_requests_total', { route: '/wagering/transactions' })).toBe(1); // sem dupla contagem
    expect(sampleValue(families, 'http_request_duration_seconds_count', { method: 'POST', route: '/wagering/transactions', status: '499' })).toBe(1);
  }, 40_000);

  test('conflito de lock: 55P03 conta uma vez em db_lock_conflicts_total, e o 503 só aparece nos status HTTP', async () => {
    const app = await start({ database: { lockTimeoutMs: 300 } });
    const wallet = await createWalletViaApi(app, '100.00');
    const lock = await holdWalletLock(orm, wallet.id);
    try {
      const result = await submit(app, wagerPayload(wallet, { money: brl('5.00') }));
      expect(result.status).toBe(503);
      expect(result.headers.get('retry-after')).toBe('1');
    } finally {
      await lock.release();
    }
    const { families } = await scrape(app);
    expect(sampleValue(families, 'db_lock_conflicts_total', { sqlstate: '55P03' })).toBe(1);
    expect(sumWhere(families, 'db_lock_conflicts_total')).toBe(1);
    expect(sampleValue(families, 'http_requests_total', { method: 'POST', route: '/wagering/transactions', status: '503' })).toBe(1);
    expect(sumWhere(families, 'wager_transactions_total')).toBe(0); // nada foi gravado
  }, 30_000);

  test('a transição PENDING_REFERENCE -> PROCESSED feita pelo worker de pendentes conta em wager_transactions_total', async () => {
    const clock = new ManualClock(new Date());
    const app = await start({ clock });
    const wallet: WalletBody = await createWalletViaApi(app, '100.00');
    const betPayload = wagerPayload(wallet, { kind: 'BET', money: brl('20.00') });
    const refund = wagerPayload(wallet, {
      kind: 'REFUND', money: brl('20.00'), referenceExternalTransactionId: betPayload.externalTransactionId,
    });
    const early = await submit(app, refund); // a BET ainda não chegou
    expect(early.status).toBe(202);
    expect((await submit(app, betPayload)).status).toBe(200);

    clock.advance(DEFAULT_PENDING_REFERENCE_POLICY.backoff.maxMs);
    const resolved = await app.app.get(ResolvePendingReference).execute(early.body.transactionId as string);
    expect(resolved.outcome).toBe('resolved');

    const { families } = await scrape(app);
    expect(sampleValue(families, 'wager_transactions_total', { status: 'PENDING_REFERENCE', kind: 'REFUND' })).toBe(1);
    expect(sampleValue(families, 'wager_transactions_total', { status: 'PROCESSED', kind: 'BET' })).toBe(1);
    expect(sampleValue(families, 'wager_transactions_total', { status: 'PROCESSED', kind: 'REFUND' })).toBe(1);
  });
});

describe('outbox lag no scrape', () => {
  test('o lag é calculado contra o banco a cada scrape, não é um valor guardado', async () => {
    await sql(`DELETE FROM outbox`); // o teste mede a linha pendente mais antiga: só a desta wallet
    const clock = new ManualClock(new Date());
    const app = await start({ clock }); // publisher desligado: o evento fica pendente
    expect(sampleValue((await scrape(app)).families, 'outbox_lag_seconds')).toBe(0);

    await createWalletViaApi(app, '100.00'); // WalletBalanceChanged pendente, occurred_at = agora (relógio manual)
    clock.advance(90_000);
    expect(sampleValue((await scrape(app)).families, 'outbox_lag_seconds')).toBe(90);
    clock.advance(30_000);
    expect(sampleValue((await scrape(app)).families, 'outbox_lag_seconds')).toBe(120);
  });

  test('banco fora do ar: /metrics responde 200, omite o lag e conta a degradação uma vez por consulta real', async () => {
    const clock = new ManualClock(new Date());
    const app = await start({ clock, database: { url: `postgres://wagering:wagering@127.0.0.1:${closedPort()}/wagering_test` } });
    const { response, families } = await scrape(app);
    expect(response.status).toBe(200);
    expect(families.has('outbox_lag_seconds')).toBe(false);
    expect(sampleValue(families, 'metrics_scrape_degraded_total', { source: 'outbox_lag' })).toBe(1);
    // Dentro do cache, a falha é reaproveitada: o gauge continua omitido e o banco não é consultado de novo.
    const cached = (await scrape(app)).families;
    expect(cached.has('outbox_lag_seconds')).toBe(false);
    expect(sampleValue(cached, 'metrics_scrape_degraded_total', { source: 'outbox_lag' })).toBe(1);
    clock.advance(LAG_CACHE_TTL_MS);
    expect(sampleValue((await scrape(app)).families, 'metrics_scrape_degraded_total', { source: 'outbox_lag' })).toBe(2);
  });

  test('cache de 5 s pelo Clock: dentro do prazo a leitura é reaproveitada, mas o lag continua andando', async () => {
    await sql(`DELETE FROM outbox`);
    const clock = new ManualClock(new Date());
    const app = await start({ clock });
    expect(sampleValue((await scrape(app)).families, 'outbox_lag_seconds')).toBe(0); // lido: nenhuma pendente

    await createWalletViaApi(app, '100.00'); // pendente com occurred_at = t0 + 0
    clock.advance(LAG_CACHE_TTL_MS - 1);
    expect(sampleValue((await scrape(app)).families, 'outbox_lag_seconds')).toBe(0); // leitura em cache: ainda "nenhuma"
    clock.advance(1);
    expect(sampleValue((await scrape(app)).families, 'outbox_lag_seconds')).toBe(5); // releu: 5 s de idade
    clock.advance(2_000);
    expect(sampleValue((await scrape(app)).families, 'outbox_lag_seconds')).toBe(7); // em cache, mas now − oldest anda
  });

  test('statement_timeout: com a outbox travada, o scrape omite o lag em ~2 s, a sessão é cancelada no banco e scrapes simultâneos dividem a consulta', async () => {
    const app = await start({ clock: new ManualClock(new Date()) });
    const { promise: locked, resolve: signalLocked } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute(`LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE`);
      signalLocked();
      await released;
    });
    try {
      await locked;
      const [first, second] = await Promise.all([scrape(app), scrape(app)]);
      for (const { families } of [first, second]) expect(families.has('outbox_lag_seconds')).toBe(false);
      // Uma consulta real para os dois scrapes: a degradação conta uma vez.
      expect(sampleValue(second.families, 'metrics_scrape_degraded_total', { source: 'outbox_lag' })).toBe(1);
      // A consulta não fica esperando o lock no banco até o lock_timeout (10 s): o statement_timeout a cancela, e a
      // conexão volta ao pool. Sem o SET LOCAL, ela continuaria em pg_stat_activity aqui.
      await waitFor(async () => (await sql(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND state = 'active' AND query ILIKE '%min(occurred_at)%'`,
      ))[0]?.n, (n) => n === 0, 1_500);
    } finally {
      release();
      await holder;
    }
  });
});
