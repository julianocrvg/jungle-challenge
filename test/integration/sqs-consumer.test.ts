import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteQueueCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../src/application/errors';
import { ResolvePendingReference } from '../../src/application/wagering/resolve-pending-reference';
import type { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { BunIdGenerator } from '../../src/infrastructure/id/bun-id-generator';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import type { WagerTransactionsConsumer } from '../../src/interface/workers/wager-transactions-consumer.worker';
import { startTestApp, submit as submitHttp } from './support/app';
import {
  betData,
  buildConsumer,
  createTempQueuePair,
  envelope,
  holdWalletLock,
  type QueuePair,
  queueDepth,
  receiveDeadLetters,
  sendMessages,
} from './support/consumer';
import { createTestOrm, insertWallet, type Sql, sqlRunner, walletsDivergingFromLedger, type WalletFixture } from './support/database';
import { CapturingStructuredLogger, SQS, waitFor } from './support/outbox';

/*
 * Consumidor de wager-transactions.fifo contra Postgres e LocalStack reais (ARCHITECTURE 7). Cada teste tem a
 * sua fila e a sua DLQ temporárias. Esperas por polling com prazo, nunca sleep arbitrário.
 */

let orm: MikroORM;
let sql: Sql;
let client: SQSClient;
let queues: QueuePair;
const running: WagerTransactionsConsumer[] = [];
const loggers: CapturingStructuredLogger[] = [];
/** Um valor monetário (`25.00`), o objeto `money` ou o campo `amount`: nada disso pode aparecer num log. */
const MONETARY = /\d+\.\d{2}(?!\d)|"money"|"amount"/;

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  client = createSqsClient(SQS);
});

beforeEach(async () => {
  queues = await createTempQueuePair(client, 'consumer-test');
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((c) => c.stop()));
  // Nenhum log do consumidor traz o corpo da mensagem nem valores monetários (ARCHITECTURE 7.8).
  const leaked = loggers.splice(0).flatMap((l) => l.entries).filter((e) => MONETARY.test(JSON.stringify(e)));
  expect(leaked).toEqual([]);
  await client.send(new DeleteQueueCommand({ QueueUrl: queues.queueUrl }));
  await client.send(new DeleteQueueCommand({ QueueUrl: queues.dlqUrl }));
  // Invariante de todos os testes: saldo materializado == saldo reconstruído pelo ledger.
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
});

afterAll(async () => {
  client?.destroy();
  await orm?.close(true);
});

function start(setup: Omit<Parameters<typeof buildConsumer>[0], 'orm' | 'queues' | 'client'> = {}) {
  const built = buildConsumer({ orm, queues, client, ...setup });
  built.consumer.start();
  running.push(built.consumer);
  loggers.push(built.logger);
  return built;
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  return row?.balance as string;
}

async function count(table: string, where: string, params: unknown[]): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return row?.n as number;
}

/** Lançamentos da wallet, sem o de abertura. */
const ledgerEntries = (walletId: string) =>
  count('wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id', `l.wallet_id = ? AND t.kind <> 'OPENING'`, [walletId]);

const drained = () => waitFor(() => queueDepth(client, queues.queueUrl), (n) => n === 0, 20_000);

describe('SQS consumer', () => {
  test('bootstrap refuses a redrive maxReceiveCount below 3x the attempt limit', async () => {
    // A fila temporária tem maxReceiveCount 9 = 3 x 3.
    await buildConsumer({ orm, queues, client }).consumer.verifyRedrivePolicy();
    const strict = buildConsumer({ orm, queues, client, options: { maxAttempts: 4 } }).consumer;
    await expect(strict.verifyRedrivePolicy()).rejects.toThrow(/at least 3 x SQS_CONSUMER_MAX_ATTEMPTS \(4\) = 12/);
  });

  test('the same message delivered 10 times has a single effect', async () => {
    const wallet = await insertWallet(sql);
    const body = envelope(betData(wallet));
    await sendMessages(client, queues.queueUrl, Array.from({ length: 10 }, () => ({ body, groupId: wallet.walletId })));

    const { metrics } = start();
    await waitFor(async () => metrics.counter('sqs_consumer_duplicates_total', { level: 'inbox' }), (n) => n === 9);
    await drained();

    expect(metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' })).toBe(1);
    expect(await count('inbox', 'message_id = ?', [body.messageId])).toBe(1);
    expect(await ledgerEntries(wallet.walletId)).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    expect(metrics.summary('sqs_consumer_processing_seconds')?.count).toBe(10);
  });

  test('the same business transaction with a new messageId is an idempotency replay', async () => {
    const wallet = await insertWallet(sql);
    const data = betData(wallet);
    await sendMessages(client, queues.queueUrl, [
      { body: envelope(data), groupId: wallet.walletId },
      { body: envelope(data), groupId: wallet.walletId },
    ]);

    const { metrics } = start();
    await waitFor(async () => metrics.counter('sqs_consumer_duplicates_total', { level: 'idempotency' }), (n) => n === 1);
    await drained();

    expect(metrics.counter('sqs_consumer_duplicates_total', { level: 'inbox' })).toBe(0);
    expect(metrics.counter('sqs_consumer_messages_total', { outcome: 'replay' })).toBe(1);
    expect(await ledgerEntries(wallet.walletId)).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
  });

  test('a transaction submitted over HTTP and then over SQS is a replay', async () => {
    const api = await startTestApp();
    try {
      const wallet = await insertWallet(sql);
      const data = betData(wallet);
      const http = await submitHttp(api, data);
      expect(http.status).toBe(200);

      // Sem idempotencyKey em `data`: o default é o mesmo `{providerId}:{externalTransactionId}` do HTTP.
      const message = envelope(data);
      await sendMessages(client, queues.queueUrl, [{ body: message, groupId: wallet.walletId }]);
      const { metrics } = start();
      await waitFor(async () => metrics.counter('sqs_consumer_duplicates_total', { level: 'idempotency' }), (n) => n === 1);
      await drained();

      expect(await count('inbox', 'message_id = ?', [message.messageId])).toBe(1);
      expect(await ledgerEntries(wallet.walletId)).toBe(1);
      expect(await balanceOf(wallet.walletId)).toBe('90.00');
    } finally {
      await api.close();
    }
  });

  test('poison messages go to the DLQ with a reason and do not block the wallet group', async () => {
    const wallet = await insertWallet(sql);
    const group = wallet.walletId;
    const firstData = betData(wallet);
    const first = envelope(firstData);
    const ghost: WalletFixture = { walletId: Bun.randomUUIDv7(), playerId: wallet.playerId, openingTxId: null };
    await sendMessages(client, queues.queueUrl, [
      { body: '{not json', groupId: group },
      { body: first, groupId: group },
      { body: { ...envelope(betData(wallet, { money: { amount: '99.00', currency: 'BRL' } })), messageId: first.messageId }, groupId: group },
      // Mesma key (default) com outro valor, messageId novo: 409 da idempotência, pelo caminho real da UoW.
      { body: envelope({ ...firstData, money: { amount: '7.00', currency: 'BRL' } }), groupId: group },
      // Mesmo externalTransactionId com outra key: violação de wt_provider_external_uq.
      { body: envelope({ ...firstData, idempotencyKey: 'provider-a:another-key' }), groupId: group },
      { body: { ...envelope(betData(wallet)), type: 'WalletCreated' }, groupId: group },
      { body: envelope(betData(wallet, { kind: 'OPENING' })), groupId: group },
      { body: envelope(betData(ghost)), groupId: group },
      { body: envelope(betData(wallet)), groupId: group },
    ]);

    const startedAt = Date.now();
    const { metrics } = start();
    await waitFor(async () => metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' }), (n) => n === 2);
    await drained();
    // Muito antes da visibilidade de 30 s: nenhuma mensagem venenosa segurou o grupo.
    expect(Date.now() - startedAt).toBeLessThan(15_000);

    const dead = await receiveDeadLetters(client, queues.dlqUrl, 7);
    expect(dead.map((d) => d.reason).sort()).toEqual([
      'EXTERNAL_TRANSACTION_ID_CONFLICT', 'IDEMPOTENCY_KEY_CONFLICT', 'INBOX_MESSAGE_CONFLICT', 'INVALID_JSON',
      'INVALID_PAYLOAD', 'UNKNOWN_MESSAGE_TYPE', 'WALLET_NOT_FOUND',
    ]);
    expect(metrics.counter('sqs_consumer_retries_total', { reason: 'UNEXPECTED_ERROR' })).toBe(0);
    // A DLQ preserva o corpo e o grupo originais: reenviar dela para a fila é seguro (ARCHITECTURE 7.6).
    expect(dead.every((d) => d.groupId === group)).toBe(true);
    expect(dead.find((d) => d.reason === 'INVALID_JSON')?.body).toBe('{not json');
    expect(metrics.counter('sqs_consumer_dlq_total', { reason: 'WALLET_NOT_FOUND' })).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('80.00');
    expect(await count('wager_transactions', 'wallet_id = ?', [ghost.walletId])).toBe(0);
  });

  test('a transient failure (lock timeout) is retried with backoff and applied once', async () => {
    const wallet = await insertWallet(sql);
    const message = envelope(betData(wallet));
    const lock = await holdWalletLock(orm, wallet.walletId);
    await sendMessages(client, queues.queueUrl, [{ body: message, groupId: wallet.walletId }]);

    const { metrics } = start({ lockTimeoutMs: 300 });
    await waitFor(async () => metrics.counter('sqs_consumer_retries_total', { reason: '55P03' }), (n) => n >= 1);
    expect(await count('inbox', 'message_id = ?', [message.messageId])).toBe(0); // desfeita junto
    await lock.release();
    await waitFor(async () => metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' }), (n) => n === 1);
    await drained();

    expect(await ledgerEntries(wallet.walletId)).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    expect(metrics.counter('sqs_consumer_dlq_total', { reason: 'MAX_ATTEMPTS_EXCEEDED' })).toBe(0);
  });

  test.each([
    ['transient', () => new TransientInfrastructureError('injected'), 'SERVICE_UNAVAILABLE'],
    // A mensagem do erro cita um valor e um pedaço do corpo: o log não pode repetir nenhum dos dois.
    ['unexpected', () => new TypeError('bug while debiting 10.00 from {"money":{"amount":"10.00"}}'), 'UNEXPECTED_ERROR'],
  ])('a %s failure that persists goes to the DLQ after the attempt limit; the BET behind it is processed', async (_, makeError, detail) => {
    const wallet = await insertWallet(sql);
    const leader = envelope(betData(wallet));
    const follower = envelope(betData(wallet));
    await sendMessages(client, queues.queueUrl, [
      { body: leader, groupId: wallet.walletId },
      { body: follower, groupId: wallet.walletId },
    ]);
    const failLeader = (real: SubmitWagerTransaction) => ({
      execute: (command) => (command.inbox?.messageId === leader.messageId ? Promise.reject(makeError()) : real.execute(command)),
    }) as SubmitWagerTransaction;

    const { metrics, logger } = start({ wrapSubmit: failLeader });
    await waitFor(async () => metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' }), (n) => n === 1, 30_000);
    await drained();

    const dead = await receiveDeadLetters(client, queues.dlqUrl, 1);
    expect(dead.map((d) => [d.reason, d.detail])).toEqual([['MAX_ATTEMPTS_EXCEEDED', detail]]);
    expect(JSON.parse(dead[0]?.body ?? '{}').messageId).toBe(leader.messageId);
    expect(await count('inbox', 'message_id = ?', [follower.messageId])).toBe(1);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    if (detail === 'UNEXPECTED_ERROR') {
      const errors = logger.entries.filter((e) => e.level === 'error');
      expect(errors.length).toBeGreaterThan(0);
      // Os frames do stack ficam (diagnóstico); a mensagem do erro, não. O afterEach confere os valores.
      expect(errors.every((e) => /^at \S/m.test(String(e.fields.stack)) && !String(e.fields.stack).includes('bug while'))).toBe(true);
    }
  }, 40_000);

  test('REFUND delivered before its BET waits as PENDING_REFERENCE and resolves later', async () => {
    const wallet = await insertWallet(sql);
    const betExternalId = `bet-${Bun.randomUUIDv7()}`;
    const refund = envelope(betData(wallet, { kind: 'REFUND', referenceExternalTransactionId: betExternalId }));
    const bet = envelope(betData(wallet, { externalTransactionId: betExternalId }));
    await sendMessages(client, queues.queueUrl, [
      { body: refund, groupId: wallet.walletId },
      { body: bet, groupId: wallet.walletId },
    ]);

    const { metrics } = start();
    await waitFor(async () => metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' }), (n) => n === 1);
    await drained();
    expect(metrics.counter('sqs_consumer_messages_total', { outcome: 'PENDING_REFERENCE' })).toBe(1);

    const [pending] = await sql(`SELECT id FROM wager_transactions WHERE kind = 'REFUND' AND wallet_id = ?`, [wallet.walletId]);
    // O use case do worker é chamado direto, com um relógio adiantado em um degrau máximo do backoff: a pendente
    // já venceu e o prazo de 1 h ainda não.
    const ahead = { now: () => new Date(Date.now() + DEFAULT_PENDING_REFERENCE_POLICY.backoff.maxMs) };
    const resolver = new ResolvePendingReference(
      new MikroOrmUnitOfWork(orm, 10_000), new BunIdGenerator(), ahead, DEFAULT_PENDING_REFERENCE_POLICY,
    );
    const resolved = await resolver.execute(pending?.id as string);
    expect(resolved.transaction?.status).toBe('PROCESSED' as never);
    expect(await ledgerEntries(wallet.walletId)).toBe(2);
    expect(await balanceOf(wallet.walletId)).toBe('100.00');
  });

  test('shutdown releases received-but-not-started messages at once and finishes the one in progress', async () => {
    const wallets = await Promise.all([insertWallet(sql), insertWallet(sql), insertWallet(sql)]);
    // As três wallets travadas: seja qual for o grupo que começar, ele fica em andamento e os outros dois não começam.
    const locks = await Promise.all(wallets.map((w) => holdWalletLock(orm, w.walletId)));
    const messages = wallets.map((w) => envelope(betData(w)));
    await sendMessages(client, queues.queueUrl, messages.map((body, i) => ({ body, groupId: wallets[i]?.walletId ?? '' })));

    const { consumer, metrics } = start({ options: { concurrency: 1 } });
    await waitFor(async () => (await sql(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`,
    ))[0]?.n as number, (n) => n === 1);

    let stopped = false;
    const stopping = consumer.stop().then(() => { stopped = true; });
    await waitFor(async () => metrics.counter('sqs_consumer_released_total', { reason: 'shutdown' }), (n) => n === 2);

    // Visibilidade devolvida: outro consumidor recebe as duas agora, sem esperar os 30 s.
    const probe = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
    expect(probe.Messages?.length).toBe(2);
    expect(stopped).toBe(false); // a mensagem em andamento ainda espera o lock

    await Promise.all(locks.map((l) => l.release()));
    await stopping;
    expect(metrics.counter('sqs_consumer_messages_total', { outcome: 'PROCESSED' })).toBe(1);
    const processed = await Promise.all(messages.map((m) => count('inbox', 'message_id = ?', [m.messageId])));
    expect(processed.reduce((a, b) => a + b, 0)).toBe(1);
  });
});
