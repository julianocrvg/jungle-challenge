import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { NestStructuredLogger } from '../../src/infrastructure/logging/nest-structured-logger';
import type { WagerTransactionsConsumer } from '../../src/interface/workers/wager-transactions-consumer.worker';
import { CapturingLogger, createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload } from './support/app';
import { betData, buildConsumer, createTempQueuePair, envelope, type QueuePair, sendMessages } from './support/consumer';
import { createTestOrm, insertWallet, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { assertCaptureWired, monetaryLeaks } from './support/logs';
import { SQS, waitFor } from './support/outbox';

/*
 * Middleware de requisição e contexto de log (ARCHITECTURE 11.3) com Nest, Express, Postgres e LocalStack reais:
 * correlationId, rota como template, ids preenchidos pelo fluxo, ruído de health fora do info e o mesmo contexto
 * no filtro de erros e no consumidor SQS.
 */

let orm: MikroORM;
let sql: Sql;
let api: TestApp;
let client: SQSClient;
const running: WagerTransactionsConsumer[] = [];
const queueUrls: string[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  api = await startTestApp();
  assertCaptureWired(api.logger);
  client = createSqsClient(SQS);
}, 30_000);

afterAll(async () => {
  await api?.close();
  for (const url of queueUrls) await client.send(new DeleteQueueCommand({ QueueUrl: url }));
  client?.destroy();
  await orm?.close(true);
});

beforeEach(() => api.logger.clear());

afterEach(async () => {
  await Promise.all(running.splice(0).map((c) => c.stop()));
  expect(monetaryLeaks(api.logger.entries)).toEqual([]);
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Line { level: string; fields: Record<string, unknown> }

/** As linhas `http request` capturadas, com os campos do JSON. */
function requestLines(): Line[] {
  return api.logger.entries
    .map((entry) => ({ level: entry.level, fields: JSON.parse(entry.message) as Record<string, unknown> }))
    .filter((line) => line.fields.message === 'http request');
}

const BRL_BET = (wallet: Awaited<ReturnType<typeof createWalletViaApi>>) =>
  wagerPayload(wallet, { money: brl('10.00') });

describe('correlationId', () => {
  test('o X-Correlation-Id válido é reaproveitado, devolvido no header e está na linha da requisição', async () => {
    const response = await fetch(`${api.baseUrl}/health/live`, { headers: { 'x-correlation-id': 'corr-ok-1' } });
    expect(response.headers.get('x-correlation-id')).toBe('corr-ok-1');

    const wallet = await createWalletViaApi(api, '100.00');
    api.logger.clear();
    const payload = BRL_BET(wallet);
    const result = await api.post('/wagering/transactions', payload, {
      'idempotency-key': `provider-a:${payload.externalTransactionId}`, 'x-correlation-id': 'corr-ok-2',
    });
    expect(result.headers.get('x-correlation-id')).toBe('corr-ok-2');
    expect(requestLines()[0]?.fields).toMatchObject({ correlationId: 'corr-ok-2', method: 'POST', status: 200 });
  });

  test.each([
    ['grande demais', 'a'.repeat(65)],
    ['com espaço', 'has space'],
    ['com aspas', 'quote"d'],
  ])('um X-Correlation-Id %s é substituído por um gerado', async (_name, bad) => {
    const response = await fetch(`${api.baseUrl}/wallets/${Bun.randomUUIDv7()}`, { headers: { 'x-correlation-id': bad } });
    const echoed = response.headers.get('x-correlation-id');
    expect(echoed).not.toBe(bad);
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(api.logger.entries)).not.toContain(bad);
  });

  test('o mesmo correlationId vai para a linha de log, o header e o evento da outbox', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    api.logger.clear();
    const result = await submit(api, BRL_BET(wallet));
    const correlationId = result.headers.get('x-correlation-id')!;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestLines()[0]?.fields.correlationId).toBe(correlationId);

    const rows = await sql(`SELECT payload->>'correlationId' AS correlation_id FROM outbox WHERE aggregate_id = ? ORDER BY occurred_at DESC LIMIT 1`, [wallet.id]);
    expect(rows[0]?.correlation_id).toBe(correlationId);
  });
});

describe('linha da requisição', () => {
  test('rota como template, status, duração inteira e os ids do fluxo; nunca a URL real nem o corpo', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    api.logger.clear();
    const payload = BRL_BET(wallet);
    const result = await submit(api, payload);
    const [line] = requestLines();
    expect(line?.level).toBe('log');
    expect(line?.fields).toMatchObject({
      method: 'POST', route: '/wagering/transactions', status: 200,
      walletId: wallet.id, providerId: 'provider-a', transactionId: result.body.transactionId,
    });
    expect(Number.isInteger(line?.fields.durationMs)).toBe(true);

    api.logger.clear();
    await fetch(`${api.baseUrl}/wallets/${wallet.id}/ledger`);
    const ledger = requestLines()[0]?.fields;
    expect(ledger).toMatchObject({ method: 'GET', route: '/wallets/:walletId/ledger', status: 200, walletId: wallet.id });
    // O id real aparece só como campo `walletId` (um id, não segredo); a URL com o id não aparece em lugar nenhum.
    expect(JSON.stringify(api.logger.entries)).not.toContain(`/wallets/${wallet.id}`);
    expect(JSON.stringify(api.logger.entries)).not.toContain(String(payload.externalTransactionId));
  });

  test('rota inexistente é "unmatched" e a URL pedida não é logada', async () => {
    const response = await fetch(`${api.baseUrl}/does/not/exist/secret-9.99`);
    expect(response.status).toBe(404);
    expect(requestLines()[0]?.fields).toMatchObject({ route: 'unmatched', status: 404, method: 'GET' });
    expect(JSON.stringify(api.logger.entries)).not.toContain('secret-9.99');
  });

  test('um 422 (rejeição de negócio) e um 409 também geram a linha, com o status', async () => {
    const wallet = await createWalletViaApi(api, '10.00');
    api.logger.clear();
    const rejected = await submit(api, wagerPayload(wallet, { money: brl('50.00') }));
    expect(rejected.status).toBe(422);
    const conflicting = BRL_BET(wallet);
    await submit(api, conflicting);
    const conflict = await submit(api, { ...conflicting, money: brl('11.00') }, `${conflicting.providerId}:${conflicting.externalTransactionId}`);
    expect(conflict.status).toBe(409);
    expect(requestLines().map((l) => l.fields.status)).toEqual([422, 200, 409]);
  });

  test('requisições em paralelo não misturam correlationId nem ids', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => createWalletViaApi(api, '100.00')));
    api.logger.clear();
    await Promise.all(wallets.map(async (wallet, i) => {
      const payload = BRL_BET(wallet);
      await api.post('/wagering/transactions', payload, {
        'idempotency-key': `provider-a:${payload.externalTransactionId}`, 'x-correlation-id': `par-${i}`,
      });
    }));
    const lines = requestLines().map((l) => l.fields);
    expect(lines).toHaveLength(12);
    for (const [i, wallet] of wallets.entries()) {
      expect(lines.find((f) => f.correlationId === `par-${i}`)?.walletId).toBe(wallet.id);
    }
  });

  test('o adapter é o Express (a rota vem de request.route.path)', () => {
    expect(api.app.getHttpAdapter().getType()).toBe('express');
  });
});

describe('ruído', () => {
  test('/health/* não sai em nível info (só debug)', async () => {
    await fetch(`${api.baseUrl}/health/live`);
    await fetch(`${api.baseUrl}/health/ready`);
    const lines = requestLines();
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.level === 'debug')).toBe(true);
  });
});

describe('filtro de erros', () => {
  test('o log de 5xx do filtro carrega o mesmo correlationId da requisição', async () => {
    const w = await createWalletViaApi(api, '100.00');
    const taken = await submit(api, BRL_BET(w));
    api.logger.clear();

    api.ids.enqueue(taken.body.transactionId as string); // colide com a PK de uma transação existente
    const payload = BRL_BET(w);
    const result = await api.post('/wagering/transactions', payload, {
      'idempotency-key': `provider-a:${payload.externalTransactionId}`, 'x-correlation-id': 'corr-5xx-1',
    });
    expect(result.status).toBe(500);

    const filterLog = api.logger.entries
      .map((e) => JSON.parse(e.message) as Record<string, unknown>)
      .find((f) => f.message === 'Request failed with an unexpected error');
    expect(filterLog).toMatchObject({ correlationId: 'corr-5xx-1', walletId: w.id, providerId: 'provider-a', status: 500 });
    const [line] = requestLines();
    expect(line?.level).toBe('error');
    expect(line?.fields.correlationId).toBe('corr-5xx-1');
  });
});

describe('consumidor SQS', () => {
  test('o log da mensagem tem correlationId = messageId e os ids do fluxo, com o NestStructuredLogger real', async () => {
    const queues: QueuePair = await createTempQueuePair(client, 'reqlog');
    queueUrls.push(queues.queueUrl, queues.dlqUrl);
    const wallet = await insertWallet(sql);
    const body = envelope(betData(wallet));
    await sendMessages(client, queues.queueUrl, [{ body, groupId: wallet.walletId }]);

    // O logger do Nest é estático: o consumidor loga pelo logger capturado deste app.
    const capture = new CapturingLogger();
    Logger.overrideLogger(capture);
    const { consumer, metrics } = buildConsumer({
      orm, queues, client, structuredLogger: new NestStructuredLogger('WagerConsumer'),
    });
    consumer.start();
    running.push(consumer);
    await waitFor(async () => metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' }), (n) => n === 1);

    const processed = capture.entries
      .map((e) => JSON.parse(e.message) as Record<string, unknown>)
      .find((f) => f.message === 'Wager message processed');
    expect(processed).toMatchObject({
      correlationId: body.messageId, messageId: body.messageId, walletId: wallet.walletId, providerId: 'provider-a',
    });
    expect(typeof processed?.transactionId).toBe('string');
    expect(typeof processed?.sqsMessageId).toBe('string');
    expect(monetaryLeaks(capture.entries)).toEqual([]);
    Logger.overrideLogger(api.logger);
  }, 40_000);
});

describe('correlationId e idempotência', () => {
  test('o correlationId não entra no payloadHash: a mesma submissão com outro X-Correlation-Id é replay, não 409', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const payload = BRL_BET(wallet);
    const headers = { 'idempotency-key': `provider-a:${payload.externalTransactionId}` };
    const first = await api.post('/wagering/transactions', payload, { ...headers, 'x-correlation-id': 'corr-first' });
    const second = await api.post('/wagering/transactions', payload, { ...headers, 'x-correlation-id': 'corr-second' });
    const third = await api.post('/wagering/transactions', payload, headers); // gerado

    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    expect(first.body.idempotentReplay).toBe(false);
    expect(second.body.idempotentReplay).toBe(true);
    expect(third.body.idempotentReplay).toBe(true);
    expect(second.body.transactionId).toBe(first.body.transactionId);
    expect(second.headers.get('x-correlation-id')).toBe('corr-second');
    const [debits] = await sql(`SELECT count(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`, [wallet.id]);
    expect(debits?.n).toBe(1);
  });
});

describe('workers', () => {
  test('o publisher da outbox abre um contexto de log por lote, com correlationId próprio', async () => {
    const capture = new CapturingLogger();
    const worker = await startTestApp({
      logger: capture,
      outbox: { enabled: true, pollIntervalMs: 50 },
      // Fila que não existe: o lote falha e o publisher loga (sem perder o evento).
      sqs: { eventsQueueUrl: `${SQS.endpoint}/000000000000/does-not-exist-${Bun.randomUUIDv7()}.fifo` },
    });
    try {
      await createWalletViaApi(worker, '100.00'); // gera um evento WalletBalanceChanged na outbox
      const lines = (): Record<string, unknown>[] => capture.entries
        .filter((e) => e.message.startsWith('{')) // o Nest também loga texto puro ao subir
        .map((e) => JSON.parse(e.message) as Record<string, unknown>)
        .filter((f) => typeof f.message === 'string' && f.message.startsWith('Outbox batch publish failed'));
      await waitFor(async () => lines().length, (n) => n >= 2, 20_000);
      const ids = lines().map((f) => f.correlationId);
      expect(ids.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length); // um correlationId por lote
      expect(monetaryLeaks(capture.entries)).toEqual([]);
    } finally {
      await worker.close();
      Logger.overrideLogger(api.logger);
    }
  }, 40_000);
});
