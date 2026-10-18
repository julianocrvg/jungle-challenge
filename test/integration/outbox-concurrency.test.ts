import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Subprocess } from 'bun';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload } from './support/app';
import { createTestOrm, type Sql, sqlRunner, TEST_DATABASE_URL, walletsDivergingFromLedger } from './support/database';
import {
  CountingPublisher,
  countById,
  createTempFifoQueue,
  deleteQueue,
  drain,
  outboxIds,
  outboxPublisher,
  pendingOutbox,
  receiveAll,
  SQS,
  sqsPublisher,
  waitFor,
} from './support/outbox';

/*
 * Publishers concorrentes e crash entre publicar e marcar (ARCHITECTURE 6.2 e 6.3), contra Postgres e LocalStack
 * reais. Cada publisher tem ORM e pool próprios, como uma instância separada; o crash usa um processo de verdade
 * (Bun.spawn) morto no meio da transação. Fechamento: nada pendente, cada eventId uma vez na fila, saldo == ledger.
 */

let orm: MikroORM;
let sql: Sql;
let api: TestApp;
let sqs: SQSClient;
const queues: string[] = [];
const children: Subprocess[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  api = await startTestApp();
  sqs = createSqsClient(SQS);
});

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await api?.close();
  for (const queueUrl of queues) await deleteQueue(sqs, queueUrl);
  sqs?.destroy();
  await orm?.close(true);
});

async function newQueue(): Promise<string> {
  const queueUrl = await createTempFifoQueue(sqs, 'outbox-concurrency');
  queues.push(queueUrl);
  return queueUrl;
}

async function seedEvents(wallets: number, betsPerWallet: number): Promise<Set<string>> {
  const before = await outboxIds(sql);
  for (let w = 0; w < wallets; w++) {
    const wallet = await createWalletViaApi(api, '100.00');
    const bets = Array.from({ length: betsPerWallet }, () =>
      submit(api, wagerPayload(wallet, { money: { amount: '1.00', currency: 'BRL' } })));
    for (const result of await Promise.all(bets)) expect(result.status).toBe(200);
  }
  const created = new Set([...await outboxIds(sql)].filter((id) => !before.has(id)));
  expect(created.size).toBe(wallets * (1 + 2 * betsPerWallet));
  return created;
}

async function expectFullyPublished(queueUrl: string, expected: Set<string>): Promise<void> {
  expect(await pendingOutbox(sql)).toEqual([]);
  const counts = countById(await receiveAll(sqs, queueUrl, expected.size, 30_000));
  expect([...counts.entries()].filter(([, count]) => count !== 1)).toEqual([]);
  expect(new Set(counts.keys())).toEqual(expected);
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
}

/** Linhas pendentes que nenhuma outra sessão travou agora (statement isolado: o lock dura só a consulta). */
async function claimablePending(): Promise<number> {
  const rows = await sql(`SELECT id FROM outbox WHERE published_at IS NULL FOR UPDATE SKIP LOCKED`);
  return rows.length;
}

/** Lê o stdout do processo filho até uma linha que satisfaça `match`, com prazo. */
async function readLineMatching(stream: ReadableStream<Uint8Array>, match: RegExp, timeoutMs = 20_000): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const line = buffer.split('\n').find((l) => match.test(l));
      if (line !== undefined) return line;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const line = buffer.split('\n').find((l) => match.test(l));
    if (line !== undefined) return line;
    throw new Error(`child output did not match ${match}: ${buffer}`);
  } finally {
    reader.releaseLock();
  }
}

describe('concurrent publishers over the same outbox', () => {
  test('three publishers (separate pools) drain ~200 events: every event sent exactly once, none lost', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(10, 10); // 10 + 200 = 210 eventos
    const instances = await Promise.all([0, 1, 2].map(() => MikroORM.init(createOrmConfig(TEST_DATABASE_URL))));
    try {
      const publishers = instances.map((instance) => new CountingPublisher(sqsPublisher(queueUrl)));
      const published = await Promise.all(instances.map((instance, i) =>
        drain(outboxPublisher({ orm: instance, publisher: publishers[i] as CountingPublisher }).batch)));

      // SKIP LOCKED: nenhum evento foi enviado por dois publishers (nem duas vezes pelo mesmo).
      const sent = publishers.flatMap((p) => p.sent);
      expect(sent.length).toBe(created.size);
      expect(new Set(sent)).toEqual(created);
      expect(published.reduce((a, b) => a + b, 0)).toBe(created.size);
    } finally {
      await Promise.all(instances.map((instance) => instance.close(true)));
    }
    await expectFullyPublished(queueUrl, created);
  });
});

describe('crash between publishing and marking published_at', () => {
  test('a process killed after SQS accepted the batch leaves the rows pending; the resend is deduplicated by eventId', async () => {
    const queueUrl = await newQueue();
    const created = await seedEvents(3, 2); // 3 + 12 = 15 eventos: o filho pega um lote de 10

    const child = Bun.spawn([process.execPath, 'test/integration/support/outbox-crash-child.ts', queueUrl], {
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL },
    });
    children.push(child);
    const sentLine = await readLineMatching(child.stdout, /^SENT /);
    const sentByChild = JSON.parse(sentLine.slice('SENT '.length)) as string[];
    expect(sentByChild.length).toBe(10);

    // O filho segura o lock das 10 linhas que enviou; só 5 estão livres para outro publisher.
    expect(await claimablePending()).toBe(5);

    child.kill('SIGKILL');
    await child.exited;

    // O Postgres percebe a conexão fechada, desfaz a transação e solta os locks. Nada foi marcado.
    await waitFor(claimablePending, (n) => n === created.size);
    expect((await pendingOutbox(sql)).length).toBe(created.size);

    // Outra instância assume e reenvia tudo, inclusive os 10 que o SQS já tinha aceitado.
    const survivor = new CountingPublisher(sqsPublisher(queueUrl));
    await drain(outboxPublisher({ orm, publisher: survivor }).batch);
    expect(new Set(survivor.sent)).toEqual(created);
    expect(sentByChild.every((id) => survivor.sent.includes(id))).toBe(true);

    // O FIFO descartou os reenvios: cada eventId aparece uma vez só na fila.
    await expectFullyPublished(queueUrl, created);
  });
});
