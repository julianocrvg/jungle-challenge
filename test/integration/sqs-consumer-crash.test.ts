import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Subprocess } from 'bun';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import {
  betData,
  buildConsumer,
  ChildOutput,
  createTempQueuePair,
  envelope,
  type QueuePair,
  queueDepth,
  sendMessages,
} from './support/consumer';
import { createTestOrm, insertWallet, type Sql, sqlRunner, TEST_DATABASE_URL, walletsDivergingFromLedger } from './support/database';
import { SQS, waitFor } from './support/outbox';

/*
 * Crash entre o commit e o ack (ARCHITECTURE 7.2): um processo filho (Bun.spawn) processa a mensagem, commita e
 * é morto antes do DeleteMessage. A mensagem volta quando a visibilidade acaba, e outra instância a reconhece
 * como duplicata pela inbox: nenhum efeito repetido.
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
  queues = await createTempQueuePair(client, 'consumer-crash');
});

afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await client?.send(new DeleteQueueCommand({ QueueUrl: queues.queueUrl }));
  await client?.send(new DeleteQueueCommand({ QueueUrl: queues.dlqUrl }));
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  client?.destroy();
  await orm?.close(true);
});

describe('SQS consumer crash between commit and ack', () => {
  test('the redelivered message is a duplicate: one debit, one inbox row', async () => {
    const wallet = await insertWallet(sql);
    const message = envelope(betData(wallet));
    await sendMessages(client, queues.queueUrl, [{ body: message, groupId: wallet.walletId }]);

    const child = Bun.spawn(
      [process.execPath, 'test/integration/support/consumer-child.ts', 'crash-after-commit', queues.queueUrl, queues.dlqUrl],
      { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, TEST_DATABASE_URL } },
    );
    children.push(child);
    await new ChildOutput(child.stdout).line(/^COMMITTED /);

    // O commit aconteceu e o ack não: o efeito está no banco e a mensagem continua em voo no SQS.
    expect(await sql(`SELECT 1 FROM inbox WHERE message_id = ?`, [message.messageId])).toHaveLength(1);
    expect(await queueDepth(client, queues.queueUrl)).toBe(1);
    child.kill('SIGKILL');
    await child.exited;

    const { consumer, metrics } = buildConsumer({ orm, client, queues });
    consumer.start();
    try {
      await waitFor(async () => metrics.counter('sqs_consumer_duplicates_total', { level: 'inbox' }), (n) => n === 1, 20_000);
      await waitFor(() => queueDepth(client, queues.queueUrl), (n) => n === 0);
    } finally {
      await consumer.stop();
    }

    expect(metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' })).toBe(0);
    const [row] = await sql(
      `SELECT count(*)::int AS n FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
       WHERE l.wallet_id = ? AND t.kind = 'BET'`,
      [wallet.walletId],
    );
    expect(row?.n).toBe(1);
    const [balance] = await sql(`SELECT balance::text AS b FROM wallets WHERE id = ?`, [wallet.walletId]);
    expect(balance?.b).toBe('90.00');
  }, 40_000);
});
