import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Logger } from '@nestjs/common';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';
import {
  contextFields,
  currentContext,
  enrichContext,
  isValidCorrelationId,
  runWithContext,
} from '../../../src/infrastructure/logging/request-context';
import {
  methodLabel,
  requestLoggingMiddleware,
  routeTemplate,
  UNMATCHED_ROUTE,
} from '../../../src/interface/http/request-logging.middleware';

/*
 * Middleware de requisição e contexto de log (ARCHITECTURE 11.3), com um req/res de mentira. O comportamento com
 * o Nest, o Express e o Postgres de verdade está em test/integration/request-logging-http.test.ts.
 */

const lines: string[] = [];
const entries = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

beforeAll(() => {
  Logger.overrideLogger(new JsonLogger((line) => lines.push(line), 'info'));
});
afterAll(() => {
  Logger.overrideLogger(true);
});
beforeEach(() => {
  lines.length = 0;
});

interface Handled {
  status: number;
  headers: Record<string, string>;
  seenInside: ReturnType<typeof currentContext>;
}

type Listener = () => void;

/** Roda a requisição pelo middleware; `inside` roda dentro do contexto aberto (onde o controller trabalharia). */
function handle(
  request: { method?: string; path?: string; headers?: Record<string, string | string[] | undefined>; route?: { path?: unknown } },
  options: { status?: number; inside?: () => void; abort?: boolean; generate?: () => string } = {},
): Handled {
  const listeners = new Map<string, Listener[]>();
  const headers: Record<string, string> = {};
  const response = {
    statusCode: options.status ?? 200,
    writableFinished: options.abort !== true,
    setHeader: (name: string, value: string) => { headers[name] = value; },
    on: (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
  };
  let seenInside: Handled['seenInside'];
  const middleware = requestLoggingMiddleware(options.generate ?? (() => 'generated-id'));
  middleware(
    { method: 'POST', path: '/wallets', headers: {}, ...request },
    response,
    () => {
      options.inside?.();
      seenInside = currentContext() === undefined ? undefined : { ...currentContext()! };
    },
  );
  if (options.abort !== true) for (const l of listeners.get('finish') ?? []) l();
  for (const l of listeners.get('close') ?? []) l();
  return { status: response.statusCode, headers, seenInside };
}

describe('request-context', () => {
  test('enrichContext muta o mesmo objeto, sem novo run, e ignora undefined', () => {
    runWithContext({ correlationId: 'c1' }, () => {
      const same = currentContext();
      enrichContext({ walletId: 'w1', providerId: undefined });
      enrichContext({ transactionId: 't1' });
      expect(currentContext()).toBe(same);
      expect(contextFields()).toEqual({ correlationId: 'c1', walletId: 'w1', transactionId: 't1' });
    });
  });

  test('o contexto atravessa await e não vaza para fora do run', async () => {
    await runWithContext({ correlationId: 'c2' }, async () => {
      await Bun.sleep(1);
      enrichContext({ walletId: 'after-await' });
      await Promise.resolve();
      expect(contextFields()).toMatchObject({ correlationId: 'c2', walletId: 'after-await' });
    });
    expect(currentContext()).toBeUndefined();
    expect(contextFields()).toEqual({});
    enrichContext({ walletId: 'ignored' }); // sem contexto: não faz nada, não lança
  });

  test('contextos concorrentes não se misturam', async () => {
    const seen = await Promise.all(['a', 'b', 'c'].map((id) =>
      runWithContext({ correlationId: id }, async () => {
        await Bun.sleep(Math.random() * 5);
        enrichContext({ walletId: `w-${id}` });
        await Bun.sleep(Math.random() * 5);
        return contextFields();
      })));
    expect(seen).toEqual([
      { correlationId: 'a', walletId: 'w-a' },
      { correlationId: 'b', walletId: 'w-b' },
      { correlationId: 'c', walletId: 'w-c' },
    ]);
  });

  test.each([
    ['corr-123', true], ['abc.DEF_1:2-3', true], ['a'.repeat(64), true],
    ['a'.repeat(65), false], ['', false], ['has space', false], ['new\nline', false], ['emoji-😀', false],
    ['semi;colon', false], ['quote"', false], [undefined, false], [['a', 'b'], false], [123, false],
  ])('X-Correlation-Id %p válido: %p', (value, valid) => {
    expect(isValidCorrelationId(value)).toBe(valid);
  });
});

describe('requestLoggingMiddleware', () => {
  test('reaproveita o X-Correlation-Id válido, devolve no header e loga uma linha com os campos esperados', () => {
    const result = handle(
      { method: 'POST', path: '/wagering/transactions', headers: { 'x-correlation-id': 'corr-abc' }, route: { path: '/wagering/transactions' } },
      { status: 422 },
    );
    expect(result.headers['X-Correlation-Id']).toBe('corr-abc');
    expect(result.seenInside).toEqual({ correlationId: 'corr-abc' });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      level: 'info', context: 'HttpRequest', message: 'http request', method: 'POST',
      route: '/wagering/transactions', status: 422, correlationId: 'corr-abc',
    });
    expect(Number.isInteger(entries()[0]!.durationMs)).toBe(true);
  });

  test.each([
    ['grande demais', 'a'.repeat(65)],
    ['com espaço', 'a b'],
    ['com quebra de linha', 'a\nb'],
    ['com aspas', 'a"b'],
    ['vazio', ''],
    ['repetido (array)', ['a', 'b']],
  ])('X-Correlation-Id %s é descartado e um novo é gerado', (_name, value) => {
    const result = handle({ headers: { 'x-correlation-id': value } }, { generate: () => 'fresh-1' });
    expect(result.headers['X-Correlation-Id']).toBe('fresh-1');
    expect(entries()[0]!.correlationId).toBe('fresh-1');
    expect(lines.join('')).not.toContain('a b');
  });

  test('sem header, gera o id; com header válido, não consome o gerador', () => {
    let generated = 0;
    handle({ headers: {} }, { generate: () => `g${++generated}` });
    handle({ headers: { 'x-correlation-id': 'mine' } }, { generate: () => `g${++generated}` });
    expect(generated).toBe(1);
  });

  test('a rota é o template, nunca a URL real, e a query e o corpo nunca saem', () => {
    handle({
      method: 'GET',
      path: '/wallets/0194f0a8-0000-7000-8000-000000000001/ledger',
      route: { path: '/wallets/:walletId/ledger' },
      headers: { 'idempotency-key': 'secret-key-9' },
    });
    const line = lines[0]!;
    expect(entries()[0]!.route).toBe('/wallets/:walletId/ledger');
    expect(line).not.toContain('0194f0a8');
    expect(line).not.toContain('secret-key-9');
  });

  test('sem rota casada, a rota é "unmatched"; a URL real não é logada', () => {
    handle({ method: 'GET', path: '/nope/123.45/hello' }, { status: 404 });
    expect(entries()[0]).toMatchObject({ route: UNMATCHED_ROUTE, status: 404 });
    expect(lines[0]).not.toContain('123.45');
    expect(routeTemplate({ method: 'GET', path: '/x', headers: {}, route: { path: 42 } })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ method: 'GET', path: '/x', headers: {}, route: { path: 'no-slash' } })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ method: 'GET', path: '/x', headers: {}, route: { path: '/{*all}' } })).toBe(UNMATCHED_ROUTE);
    expect(routeTemplate({ method: 'GET', path: '/x', headers: {}, route: { path: '*' } })).toBe(UNMATCHED_ROUTE);
  });

  test('método fora do conjunto conhecido vira OTHER', () => {
    handle({ method: 'PURGE' });
    handle({ method: 'get' });
    expect(entries().map((e) => e.method)).toEqual(['OTHER', 'GET']);
    expect(methodLabel('X'.repeat(500))).toBe('OTHER');
  });

  test('ids preenchidos depois (no meio do fluxo) aparecem na linha final', () => {
    handle({ route: { path: '/wagering/transactions' } }, {
      inside: () => enrichContext({ walletId: 'w-1', providerId: 'prov-a', transactionId: 't-9' }),
    });
    expect(entries()[0]).toMatchObject({ walletId: 'w-1', providerId: 'prov-a', transactionId: 't-9' });
  });

  test('5xx sai como error; cliente que aborta, como warn', () => {
    handle({}, { status: 503 });
    handle({}, { status: 200, abort: true });
    expect(entries().map((e) => [e.level, e.message])).toEqual([
      ['error', 'http request'],
      ['warn', 'http request aborted by the client'],
    ]);
  });

  test.each(['/health/live', '/health/ready', '/health', '/metrics', '/metrics/'])('%s não sai em nível info', (path) => {
    handle({ method: 'GET', path, route: { path } });
    expect(lines).toEqual([]);
  });

  test('health e métricas saem com LOG_LEVEL=debug, e rota parecida não é silenciada', () => {
    Logger.overrideLogger(new JsonLogger((line) => lines.push(line), 'debug'));
    handle({ method: 'GET', path: '/health/live', route: { path: '/health/live' } });
    handle({ method: 'GET', path: '/healthy-wallet', route: { path: '/healthy-wallet' } });
    Logger.overrideLogger(new JsonLogger((line) => lines.push(line), 'info'));
    handle({ method: 'GET', path: '/healthy-wallet', route: { path: '/healthy-wallet' } });
    expect(entries().map((e) => [e.level, e.route])).toEqual([
      ['debug', '/health/live'], ['info', '/healthy-wallet'], ['info', '/healthy-wallet'],
    ]);
  });

  test('nenhum campo da linha parece valor monetário (duração inteira, ids sem ponto)', () => {
    handle({ route: { path: '/wallets' } }, { status: 201, inside: () => enrichContext({ walletId: '0194f0a8-0000-7000-8000-000000000001' }) });
    expect(lines[0]).not.toMatch(/\d+\.\d{2}(?!\d)/);
  });
});

describe('JsonLogger: nível mínimo', () => {
  test('debug e verbose só saem com LOG_LEVEL=debug/verbose; info é o padrão', () => {
    const out: string[] = [];
    const info = new JsonLogger((l) => out.push(l), 'info');
    info.debug('d'); info.verbose('v'); info.log('i'); info.warn('w');
    expect(out.map((l) => JSON.parse(l).message)).toEqual(['i', 'w']);
    out.length = 0;
    const debug = new JsonLogger((l) => out.push(l), 'debug');
    debug.verbose('v'); debug.debug('d');
    expect(out.map((l) => JSON.parse(l).message)).toEqual(['d']);
  });
});
