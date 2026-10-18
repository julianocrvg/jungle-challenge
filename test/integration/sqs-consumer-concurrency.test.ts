import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Subprocess } from 'bun';
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransaction,
} from '../../src/application/wagering/submit-wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { BunIdGenerator } from '../../src/infrastructure/id/bun-id-generator';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import {
  betData,
  ChildOutput,
  createTempQueuePair,
  envelope,
  type OutgoingMessage,
  type QueuePair,
  queueDepth,
  receiveDeadLetters,
  sendMessages,
} from './support/consumer';
import { createTestOrm, insertWallet, type Sql, sqlRunner, TEST_DATABASE_URL, walletsDivergingFromLedger } from './support/database';
import { SQS, waitFor } from './support/outbox';

/*
 * Concorrência real no consumidor (ARCHITECTURE 7.8):
 * - três consumidores em processos separados (Bun.spawn), na mesma fila e na mesma wallet, com um
 *   MessageGroupId DIFERENTE por mensagem: o FIFO não serializa nada, e a consistência tem de vir do banco;
 * - duas execuções simultâneas do use case com o mesmo messageId: um efeito, e a segunda vira duplicata
 *   pelo ON CONFLICT da inbox, sem 23505.
 */

let orm: MikroORM;
let sql: Sql;
let client: SQSClient;
let queues: QueuePair;
const children: Subprocess[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  client = createSqsClient(SQS);
  queues = await createTempQueuePair(client, 'consumer-stress');
});

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await client?.send(new DeleteQueueCommand({ QueueUrl: queues.queueUrl }));
  await client?.send(new DeleteQueueCommand({ QueueUrl: queues.dlqUrl }));
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  client?.destroy();
  await orm?.close(true);
});

async function count(where: string, params: unknown[]): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE ${where}`, params);
  return row?.n as number;
}

describe('SQS consumer under concurrency', () => {
  test('3 consumer processes on the same queue and wallet, one group per message: each effect exactly once', async () => {
    const wallet = await insertWallet(sql, '100.00');
    // 40 apostas distintas de 5.00 sobre 100.00: qualquer ordem dá exatamente 20 PROCESSED e 20 REJECTED.
    const bets = Array.from({ length: 40 }, () => envelope(betData(wallet, { money: { amount: '5.00', currency: 'BRL' } })));
    const uniqueGroup = (): string => Bun.randomUUIDv7();
    const outgoing: OutgoingMessage[] = [
      ...bets.map((body) => ({ body, groupId: uniqueGroup() })),
      // Redelivery do mesmo messageId (as 10 primeiras, mais 2 cópias cada): duplicata pela inbox.
      ...bets.slice(0, 10).flatMap((body) => [{ body, groupId: uniqueGroup() }, { body, groupId: uniqueGroup() }]),
      // Mesma transação de negócio com messageId novo (5): replay pela idempotência.
      ...bets.slice(10, 15).map((body) => ({ body: envelope(body.data as Record<string, unknown>), groupId: uniqueGroup() })),
    ];

    const outputs = [0, 1, 2].map(() => {
      const child = Bun.spawn(
        [process.execPath, 'test/integration/support/consumer-child.ts', 'run', queues.queueUrl, queues.dlqUrl],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: { ...process.env, TEST_DATABASE_URL } },
      );
      children.push(child);
      return { child, output: new ChildOutput(child.stdout) };
    });
    await Promise.all(outputs.map(({ output }) => output.line(/^READY$/)));
    // Embaralhado: a ordem de envio também não pode importar.
    await sendMessages(client, queues.queueUrl, outgoing.sort(() => Math.random() - 0.5));

    const expectedInboxRows = 40 + 5;
    await waitFor(async () => (await sql(`SELECT count(*)::int AS n FROM inbox`))[0]?.n as number, (n) => n === expectedInboxRows, 60_000);
    await waitFor(() => queueDepth(client, queues.queueUrl), (n) => n === 0, 60_000);

    // Shutdown gracioso de cada filho, que devolve as métricas.
    const metrics = await Promise.all(outputs.map(async ({ child, output }) => {
      const stdin = child.stdin as import('bun').FileSink;
      stdin.write('STOP\n');
      await stdin.end();
      const line = await output.line(/^METRICS /);
      await child.exited;
      return JSON.parse(line.slice('METRICS '.length)) as Record<string, number>;
    }));
    const total = (key: string): number => metrics.reduce((sum, m) => sum + (m[key] ?? 0), 0);
    const handledBy = metrics.map((m) => Object.entries(m)
      .filter(([k]) => k.startsWith('sqs_consumer_messages_total')).reduce((s, [, v]) => s + v, 0));

    expect(handledBy.reduce((a, b) => a + b, 0)).toBe(outgoing.length);
    // Os três processos trabalharam de fato (não é um consumidor só com dois parados).
    expect(handledBy.filter((n) => n > 0).length).toBeGreaterThanOrEqual(2);
    expect(total('sqs_consumer_duplicates_total{level="inbox"}')).toBe(20);
    expect(total('sqs_consumer_duplicates_total{level="idempotency"}')).toBe(5);
    expect(total('sqs_consumer_messages_total{outcome="PROCESSED"}')).toBe(20);
    expect(total('sqs_consumer_messages_total{outcome="REJECTED"}')).toBe(20);
    expect(Object.keys(metrics.reduce((a, m) => ({ ...a, ...m }), {})).filter((k) => k.includes('dlq') || k.includes('UNEXPECTED'))).toEqual([]);

    expect(await count(`wallet_id = ? AND kind = 'BET'`, [wallet.walletId])).toBe(40);
    expect(await count(`wallet_id = ? AND status = 'PROCESSED' AND kind = 'BET'`, [wallet.walletId])).toBe(20);
    expect(await count(`wallet_id = ? AND failure_code = 'INSUFFICIENT_FUNDS'`, [wallet.walletId])).toBe(20);
    const [w] = await sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [wallet.walletId]);
    expect(w).toEqual({ balance: '0.00', version: 21 });
    expect(await receiveDeadLetters(client, queues.dlqUrl, 0)).toEqual([]);
  }, 120_000);

  test('two simultaneous executions with the same messageId: one effect, the other a duplicate, no 23505', async () => {
    const submit = new SubmitWagerTransaction(new MikroOrmUnitOfWork(orm, 10_000), new BunIdGenerator(), { now: () => new Date() });
    for (let round = 0; round < 20; round++) {
      const wallet = await insertWallet(sql, '100.00');
      const messageId = `msg-${Bun.randomUUIDv7()}`;
      const payload = {
        ...(betData(wallet) as Omit<SubmitWagerTransactionCommand['payload'], 'kind'>),
        kind: WagerTransactionKind.Bet,
      };
      const command: SubmitWagerTransactionCommand = {
        idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
        payload,
        correlationId: messageId,
        inbox: { consumerName: 'wager-transactions', messageId },
      };

      // allSettled: um 23505 da inbox_pk apareceria aqui como rejeição.
      const results = await Promise.allSettled([submit.execute(command), submit.execute(command)]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const values = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      expect(values.map((v) => v.duplicateDelivery).sort()).toEqual([false, true]);
      expect(new Set(values.map((v) => v.transaction.id)).size).toBe(1);
      const [w] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [wallet.walletId]);
      expect(w?.balance).toBe('90.00');
    }
  });
});
