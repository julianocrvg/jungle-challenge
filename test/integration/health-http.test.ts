import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { READINESS_TIMEOUT_MS } from '../../src/interface/http/readiness';
import { startTestApp, type TestApp } from './support/app';
import { createTempQueuePair, MAX_ATTEMPTS, type QueuePair } from './support/consumer';
import { createTestOrm } from './support/database';
import { SQS } from './support/outbox';

/*
 * /health/live e /health/ready (ARCHITECTURE 10.1): live nunca toca dependências; ready confere Postgres e as
 * filas SQS desta instância, com teto por check, e responde 503 quando alguma não responde.
 */

let orm: MikroORM;
let client: SQSClient;
let queues: QueuePair;
const apps: TestApp[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  client = createSqsClient(SQS);
  queues = await createTempQueuePair(client, 'health');
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await client?.send(new DeleteQueueCommand({ QueueUrl: queues.queueUrl }));
  await client?.send(new DeleteQueueCommand({ QueueUrl: queues.dlqUrl }));
  client?.destroy();
  await orm?.close(true);
});

async function start(options: Parameters<typeof startTestApp>[0] = {}): Promise<TestApp> {
  const app = await startTestApp(options);
  apps.push(app);
  return app;
}

async function get(app: TestApp, path: string): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const started = Date.now();
  const response = await fetch(`${app.baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, ms: Date.now() - started };
}

/** Uma porta onde ninguém escuta: abre um listener numa porta livre e o fecha. */
function closedPort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

describe('health endpoints', () => {
  test('ready is 200 with Postgres and the events queue up (consumer off: its queues are not checked)', async () => {
    const app = await start();
    expect(await get(app, '/health/ready')).toMatchObject({
      status: 200, body: { status: 'ok', checks: { postgres: 'ok', 'sqs-events': 'ok' } },
    });
    expect(await get(app, '/health/live')).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  test('every response carries X-Instance-Id, error responses included', async () => {
    const app = await start({ instanceId: 'health-a' });
    expect((await fetch(`${app.baseUrl}/health/live`)).headers.get('x-instance-id')).toBe('health-a');
    const notFound = await fetch(`${app.baseUrl}/wallets/${Bun.randomUUIDv7()}`);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('x-instance-id')).toBe('health-a');
  });

  test('with the consumer on, ready also checks the transactions queue and its DLQ', async () => {
    const app = await start({
      consumer: { enabled: true, queueUrl: queues.queueUrl, deadLetterQueueUrl: queues.dlqUrl, waitTimeSeconds: 1, maxAttempts: MAX_ATTEMPTS },
    });
    expect(await get(app, '/health/ready')).toMatchObject({
      status: 200,
      body: { status: 'ok', checks: { postgres: 'ok', 'sqs-events': 'ok', 'sqs-transactions': 'ok', 'sqs-transactions-dlq': 'ok' } },
    });
  });

  test('a missing queue makes ready 503 with only that check down; live stays 200', async () => {
    const app = await start({ sqs: { eventsQueueUrl: `${SQS.endpoint}/000000000000/does-not-exist-${Bun.randomUUIDv7()}.fifo` } });
    const ready = await get(app, '/health/ready');
    expect(ready).toMatchObject({ status: 503, body: { status: 'unavailable', checks: { postgres: 'ok', 'sqs-events': 'down' } } });
    // Nenhum texto livre de erro na resposta nem no log: só o nome do probe e o nome do erro.
    expect(JSON.stringify(ready.body)).not.toContain('does-not-exist');
    const warnings = app.logger.entries.filter((e) => e.level === 'warn' && e.message.includes('readiness'));
    expect(warnings.length).toBe(1);
    expect(JSON.parse(warnings[0]!.message)).toEqual({ message: 'readiness check failed', probe: 'sqs-events', error: expect.any(String) });
    expect(await get(app, '/health/live')).toMatchObject({ status: 200 });
  });

  test('Postgres unreachable (connection refused): ready 503 with postgres down; live 200 without touching it', async () => {
    const app = await start({ database: { url: `postgres://wagering:wagering@127.0.0.1:${closedPort()}/wagering_test` } });
    expect(await get(app, '/health/ready')).toMatchObject({
      status: 503, body: { status: 'unavailable', checks: { postgres: 'down', 'sqs-events': 'ok' } },
    });
    expect(await get(app, '/health/live')).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  test('Postgres that accepts and never answers: ready gives up at the timeout instead of hanging', async () => {
    const hanging = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      const app = await start({ database: { url: `postgres://wagering:wagering@127.0.0.1:${hanging.port}/wagering_test` } });
      const ready = await get(app, '/health/ready');
      expect(ready).toMatchObject({ status: 503, body: { checks: { postgres: 'down', 'sqs-events': 'ok' } } });
      expect(ready.ms).toBeGreaterThanOrEqual(READINESS_TIMEOUT_MS - 100);
      expect(ready.ms).toBeLessThan(READINESS_TIMEOUT_MS + 3_000);
      const live = await get(app, '/health/live');
      expect(live).toMatchObject({ status: 200 });
      expect(live.ms).toBeLessThan(1_000);
    } finally {
      hanging.stop(true);
    }
  });
});
