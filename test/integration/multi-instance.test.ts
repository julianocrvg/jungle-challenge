import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { scanLogLine } from '../support/scan-log-line';
import { type WalletBody, wagerPayload } from './support/app';
import { createTempQueuePair, envelope, queueDepth, receiveDeadLetters, sendMessages } from './support/consumer';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import {
  CHILD_POOL_MAX,
  CHILD_REDRIVE_MAX_RECEIVE,
  type Instance,
  type InstanceQueues,
  killAllInstancesSync,
  spawnInstance,
  waitReady,
} from './support/instances';
import { countById, createTempFifoQueue, pendingOutbox, SQS, waitFor } from './support/outbox';

/*
 * Múltiplas instâncias reais (ARCHITECTURE 10.2): três processos `bun src/main.ts` (Bun.spawn), portas distintas,
 * mesmo Postgres e LocalStack, com publisher, consumidor e worker de pendentes ligados em todos. Cenários: duas
 * apostas de 80 sobre 100 em instâncias diferentes, a mesma aposta 50 vezes, wallets distintas, REFUND numa
 * instância e a BET em outra, crash de uma instância no meio da carga e reinício completo das três.
 *
 * Todo cenário termina em `assertConverged`: saldo == ledger, nenhuma linha da outbox pendente, cada eventId na
 * fila de eventos exatamente uma vez (a dedup do LocalStack vale: 6.1), zero 5xx e nenhum 40P01, deadlock ou nome
 * de constraint nos logs dos filhos.
 */

const TEST_TIMEOUT_MS = 120_000;
const CURRENCY = 'BRL';

/** Constraints, índices únicos e triggers do schema: nenhum deles pode aparecer num log (violação inesperada). */
const SCHEMA_OBJECTS = [
  'wallets_player_currency_uq', 'wallets_id_currency_uq', 'wallets_currency_format', 'wallets_balance_non_negative',
  'wallets_version_positive', 'wt_idempotency_key_uq', 'wt_provider_external_uq', 'wt_id_wallet_uq', 'wt_kind_valid',
  'wt_status_valid', 'wt_failure_code_valid', 'wt_currency_format', 'wt_attempts_non_negative', 'wt_amount_valid',
  'wt_round_game_required', 'wt_reference_by_kind', 'wt_processed_reversal_resolved', 'wt_failure_code_status',
  'wt_terminal_processed_at', 'wt_balance_after_terminal', 'wt_balance_after_non_negative', 'wt_single_reversal_uq',
  'wt_internal_provider_only_opening', 'ledger_wallet_currency_fk', 'ledger_transaction_wallet_fk',
  'ledger_wallet_transaction_uq', 'ledger_wallet_version_uq', 'ledger_wallet_version_positive', 'ledger_direction_valid',
  'ledger_amount_positive', 'ledger_balances_non_negative', 'ledger_arithmetic', 'wallet_ledger_entries_no_update_delete',
  'wallet_ledger_entries_no_truncate', 'inbox_pk', 'outbox_attempts_non_negative',
];
const FORBIDDEN_LOG_PATTERNS = [/40P01/, /deadlock detected/i, new RegExp(`\\b(${SCHEMA_OBJECTS.join('|')})\\b`)];

let orm: MikroORM;
let sql: Sql;
let client: SQSClient;
let queues: InstanceQueues;
/** As três instâncias vivas, na ordem dos papéis de cada cenário. */
let instances: Instance[] = [];
/** Todas as que já subiram, inclusive as mortas: os logs de todas entram na varredura. */
const spawned: Instance[] = [];
let nextInstance = 1;

interface ApiResult {
  target: string;
  instanceId: string | null;
  status: number;
  body: Record<string, unknown>;
}
/** Toda resposta da API (não do health check) recebida pelo pai: base do "zero 5xx". */
const responses: ApiResult[] = [];
/** Eventos lidos (e apagados) da fila de eventos, acumulados ao longo do arquivo. */
const drained: { eventId: string }[] = [];

class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

/** Nome, code do socket e mensagem do erro do fetch (e da causa), para um erro de rede ser diagnosticável. */
function describeFetchFailure(error: unknown): string {
  const parts = (e: unknown): string => {
    const o = e as { name?: unknown; code?: unknown; message?: unknown } | null;
    return `${String(o?.name ?? typeof e)} code=${String(o?.code ?? '-')} message=${String(o?.message ?? '-')}`;
  };
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause === undefined ? parts(error) : `${parts(error)} <- cause: ${parts(cause)}`;
}

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  // Orçamento de conexões contra o Postgres real: 3 filhos + o pool do pai, abaixo do max_connections.
  const [limits] = await sql(
    `SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved`,
  );
  const parentPool = orm.config.get('pool')?.max ?? 20;
  expect(3 * CHILD_POOL_MAX + parentPool + 10).toBeLessThanOrEqual((limits!.max as number) - (limits!.reserved as number));

  // A varredura de logs reconhece o que procura (sem isso, um regex quebrado passaria sempre).
  expect(FORBIDDEN_LOG_PATTERNS.some((p) => p.test('new row violates check constraint "wallets_balance_non_negative"'))).toBe(true);
  expect(FORBIDDEN_LOG_PATTERNS.some((p) => p.test('error: deadlock detected'))).toBe(true);
  expect(scanLogLine(JSON.stringify({ level: 'error', message: 'x', constraint: 'wallets_balance_non_negative' }), FORBIDDEN_LOG_PATTERNS)).toBe(true);

  client = createSqsClient(SQS);
  const pair = await createTempQueuePair(client, 'multi', CHILD_REDRIVE_MAX_RECEIVE);
  queues = { ...pair, eventsUrl: await createTempFifoQueue(client, 'multi-events') };
  instances = await Promise.all([0, 1, 2].map(() => spawn()));
}, 60_000);

// Antes de cada cenário, todas as instâncias vivas respondem /health/ready: nenhum cenário começa com uma instância
// ainda subindo ou já caída (um erro de rede no primeiro request seria ambíguo).
beforeEach(async () => {
  const ready = await Promise.all(instances.filter((i) => !i.killed).map((i) => waitReady(i, 15_000)));
  expect(ready.every(Boolean)).toBe(true);
}, 30_000);

afterAll(async () => {
  await Promise.all(spawned.map((instance) => instance.kill()));
  killAllInstancesSync();
  for (const url of [queues?.queueUrl, queues?.dlqUrl, queues?.eventsUrl]) {
    if (url !== undefined) await client.send(new DeleteQueueCommand({ QueueUrl: url }));
  }
  if (sql !== undefined) expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  client?.destroy();
  await orm?.close(true);
});

async function spawn(): Promise<Instance> {
  const instance = await spawnInstance(`mi-${nextInstance++}`, queues);
  spawned.push(instance);
  return instance;
}

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const brl = (amount: string): { amount: string; currency: string } => ({ amount, currency: CURRENCY });
const placeholders = (n: number): string => range(n).map(() => '?').join(', ');

// ---------- HTTP ----------

async function call(instance: Instance, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResult> {
  instance.pending++;
  try {
    let status: number;
    let instanceId: string | null;
    let text: string;
    try {
      const response = await fetch(`${instance.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
        // Sem reaproveitar conexão: uma keep-alive que o servidor já fechou dá ECONNRESET na primeira requisição
        // depois de um tempo ocioso, e um POST sem chave de idempotência não pode ser reenviado às cegas.
        keepalive: false,
      });
      status = response.status;
      instanceId = response.headers.get('x-instance-id');
      text = await response.text();
    } catch (error) {
      throw new NetworkError(`${instance.id} ${method} ${path}: ${describeFetchFailure(error)}`, { cause: error });
    }
    const result: ApiResult = { target: instance.id, instanceId, status, body: text === '' ? {} : JSON.parse(text) };
    responses.push(result);
    return result;
  } finally {
    instance.pending--;
  }
}

async function createWallet(instance: Instance, amount = '100.00'): Promise<WalletBody> {
  const result = await call(instance, 'POST', '/wallets', { playerId: Bun.randomUUIDv7(), initialBalance: brl(amount) });
  if (result.status !== 201) throw new Error(`wallet creation failed: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body as unknown as WalletBody;
}

function submit(instance: Instance, payload: Record<string, unknown>): Promise<ApiResult> {
  return call(instance, 'POST', '/wagering/transactions', payload, {
    'idempotency-key': `${payload.providerId}:${payload.externalTransactionId}`,
  });
}

let failovers = 0;
/** Reenvios que voltaram como replay: a instância morta tinha commitado e a resposta se perdeu no crash. */
let failoverReplays = 0;

/**
 * Cliente que tolera a morte de uma instância: erro de rede (a resposta nunca chegou, então o resultado é
 * desconhecido) leva ao reenvio da MESMA requisição, com a mesma Idempotency-Key, a outra instância viva. Se a
 * primeira tinha commitado, o reenvio é replay. Sem nenhuma viva, devolve undefined (o chamador guarda para depois).
 */
async function submitWithFailover(preferred: Instance, payload: Record<string, unknown>): Promise<ApiResult | undefined> {
  const candidates = [preferred, ...instances.filter((i) => i !== preferred)];
  let failedOver = false;
  for (const instance of candidates) {
    if (instance.killed) continue;
    try {
      const result = await submit(instance, payload);
      if (failedOver && result.body.idempotentReplay === true) failoverReplays++;
      return result;
    } catch (error) {
      failedOver = true;
      if (!(error instanceof NetworkError)) throw error;
      failovers++;
    }
  }
  return undefined;
}

// ---------- SQS ----------

interface SentMessage {
  body: Record<string, unknown>;
  messageId: string;
  externalId: string;
}

function betMessage(wallet: WalletBody, amount: string): SentMessage {
  const data = wagerPayload(wallet, { money: brl(amount) });
  const body = envelope(data);
  return { body, messageId: body.messageId as string, externalId: data.externalTransactionId as string };
}

/** Um MessageGroupId por envio: o FIFO não serializa nada e as mensagens se espalham entre os consumidores. */
async function sendToQueue(messages: SentMessage[]): Promise<void> {
  await sendMessages(client, queues.queueUrl, messages.map((m) => ({ body: m.body, groupId: Bun.randomUUIDv7() })));
}

function consumedBy(instance: Instance): number {
  return instance.stdout.lines.filter((line) =>
    line.includes('Wager message processed') && line.includes(`"instanceId":"${instance.id}"`)).length;
}

// ---------- Banco ----------

async function countTransactions(externalIds: string[]): Promise<number> {
  if (externalIds.length === 0) return 0;
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM wager_transactions WHERE external_transaction_id IN (${placeholders(externalIds.length)})`,
    externalIds,
  );
  return row!.n as number;
}

async function waitForTransactions(externalIds: string[], timeoutMs = 60_000): Promise<void> {
  await waitFor(() => countTransactions(externalIds), (n) => n === externalIds.length, timeoutMs);
}

/**
 * Transações de submissão em andamento numa instância (PGAPPNAME = INSTANCE_ID). Os ticks ociosos do publisher
 * (outbox) e da listagem de pendentes ficam de fora: não são trabalho que o crash possa interromper no meio.
 */
async function activeTransactions(instance: Instance): Promise<number> {
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE application_name = ? AND xact_start IS NOT NULL
       AND query NOT ILIKE '%outbox%' AND query NOT ILIKE '%status = ''PENDING_REFERENCE''%'`,
    [instance.applicationName],
  );
  return row!.n as number;
}

async function sessionsOf(names: string[]): Promise<number> {
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name IN (${placeholders(names.length)})`,
    names,
  );
  return row!.n as number;
}

/** Mensagens recebidas por algum consumidor e ainda sem ack (não visíveis). */
async function messagesInFlight(): Promise<number> {
  const output = await client.send(new GetQueueAttributesCommand({
    QueueUrl: queues.queueUrl, AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
  }));
  return Number.parseInt(output.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10);
}

const answeredBy = (instance: Instance): number => responses.filter((r) => r.instanceId === instance.id).length;

/**
 * "No meio da carga", medido na própria instância: ela já respondeu `minAnswered` requisições desta carga, ainda
 * tem requisições do pai sem resposta E tem uma transação de submissão aberta no Postgres. Só mensagens em voo na
 * fila não bastam: podem estar com outra instância. Polling até o prazo; undefined se não apareceu (o chamador
 * repete a carga). Devolve também as mensagens em voo no instante, para o log do teste.
 */
async function waitForWorkInFlight(
  candidates: Instance[], timeoutMs: number, minAnswered = 3,
): Promise<{ instance: Instance; messagesInFlight: number } | undefined> {
  const baseline = new Map(candidates.map((i) => [i, answeredBy(i)]));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const instance of candidates) {
      if (instance.pending === 0 || answeredBy(instance) - baseline.get(instance)! < minAnswered) continue;
      if (await activeTransactions(instance) > 0 && instance.pending > 0) {
        return { instance, messagesInFlight: await messagesInFlight() };
      }
    }
    await Bun.sleep(2);
  }
  return undefined;
}

// ---------- Resultado esperado (Money do domínio: nenhum number toca dinheiro) ----------

class Book {
  private readonly wallets = new Map<string, { balance: Money; entries: number }>();

  open(wallet: WalletBody, amount = '100.00'): void {
    this.wallets.set(wallet.id, { balance: Money.from(brl(amount)), entries: 1 });
  }

  debit(wallet: WalletBody, amount: string): void {
    this.apply(wallet, Money.from(brl(amount)).negate());
  }

  credit(wallet: WalletBody, amount: string): void {
    this.apply(wallet, Money.from(brl(amount)));
  }

  /** Saldo, versão e número de lançamentos de cada wallet: versão == lançamentos (OPENING em v1). */
  async verify(): Promise<void> {
    for (const [walletId, expected] of this.wallets) {
      const [row] = await sql(
        `SELECT w.balance::text AS balance, w.version,
                (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id) AS entries
         FROM wallets w WHERE w.id = ?`,
        [walletId],
      );
      expect({ walletId, ...row } as Record<string, unknown>).toEqual({
        walletId, balance: expected.balance.toJSON().amount, version: expected.entries, entries: expected.entries,
      });
    }
  }

  private apply(wallet: WalletBody, delta: Money): void {
    const current = this.wallets.get(wallet.id);
    if (current === undefined) throw new Error(`wallet ${wallet.id} not opened in the book`);
    this.wallets.set(wallet.id, { balance: current.balance.add(delta), entries: current.entries + 1 });
  }
}

// ---------- Convergência ----------

/** Recebe e apaga cada mensagem da fila de eventos até `quietPolls` leituras vazias seguidas, com prazo. */
async function drainEvents(quietPolls = 3, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (quiet < quietPolls) {
    if (Date.now() > deadline) throw new Error('events queue never went quiet');
    const output = await client.send(new ReceiveMessageCommand({
      QueueUrl: queues.eventsUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 60,
    }));
    const messages = output.Messages ?? [];
    if (messages.length === 0) {
      quiet++;
      continue;
    }
    quiet = 0;
    for (const message of messages) {
      drained.push({ eventId: (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId });
      await client.send(new DeleteMessageCommand({ QueueUrl: queues.eventsUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
}

/**
 * Linhas proibidas nos logs de todos os filhos que já subiram. Exceção documentada (ARCHITECTURE 10.2): de um
 * filho morto à força, a última linha pode ter sido cortada no meio da escrita e é ignorada; o resto vale igual.
 */
function forbiddenLogLines(): string[] {
  return spawned.flatMap((instance) => {
    const stdout = instance.killed ? instance.stdout.lines.slice(0, -1) : instance.stdout.lines;
    const stderr = instance.killed ? instance.stderr.lines.slice(0, -1) : instance.stderr.lines;
    return [...stdout, ...stderr]
      .filter((line) => scanLogLine(line, FORBIDDEN_LOG_PATTERNS))
      .map((line) => `${instance.id}: ${line}`);
  });
}

async function assertConverged(): Promise<void> {
  // Nenhuma linha da outbox pendente: os publishers vivos esvaziam tudo, inclusive o que um morto deixou travado.
  await waitFor(() => pendingOutbox(sql), (rows) => rows.length === 0, 30_000);
  await drainEvents();
  const outbox = (await sql(`SELECT id FROM outbox`)).map((row) => row.id as string).sort();
  const counts = countById(drained);
  expect([...counts.entries()].filter(([, n]) => n !== 1)).toEqual([]);
  expect([...counts.keys()].sort()).toEqual(outbox);

  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  expect(responses.filter((r) => r.status >= 500)).toEqual([]);
  // O header diz quem atendeu, e é sempre a instância a que o pai mandou.
  expect(responses.filter((r) => r.instanceId !== r.target)).toEqual([]);
  expect(forbiddenLogLines()).toEqual([]);
}

async function assertQueuesEmpty(): Promise<void> {
  await waitFor(() => queueDepth(client, queues.queueUrl), (n) => n === 0, 60_000);
  expect(await receiveDeadLetters(client, queues.dlqUrl, 0)).toEqual([]);
}

/**
 * Manda rodadas de apostas pela fila até cada instância dada ter consumido ao menos uma mensagem (quem recebe
 * cada mensagem é decisão do SQS). Até 5 rodadas de 30 apostas de 1.00 sobre 3 wallets novas.
 */
async function ensureEveryInstanceConsumed(alive: Instance[], book: Book): Promise<void> {
  const wallets = await Promise.all(range(3).map((i) => createWallet(alive[i % alive.length]!)));
  for (const wallet of wallets) book.open(wallet);
  for (let round = 0; round < 5 && alive.some((i) => consumedBy(i) === 0); round++) {
    const messages = range(30).map((i) => betMessage(wallets[i % 3]!, '1.00'));
    for (const [i] of messages.entries()) book.debit(wallets[i % 3]!, '1.00');
    await sendToQueue(messages);
    await waitForTransactions(messages.map((m) => m.externalId));
  }
  expect(alive.map((i) => ({ instance: i.id, consumed: consumedBy(i) > 0 })))
    .toEqual(alive.map((i) => ({ instance: i.id, consumed: true })));
}

function assertEveryInstanceServedHttp(alive: Instance[]): void {
  const served = new Set(responses.map((r) => r.instanceId));
  expect(alive.map((i) => ({ instance: i.id, served: served.has(i.id) })))
    .toEqual(alive.map((i) => ({ instance: i.id, served: true })));
}

// ---------- Cenários ----------

describe('3 real instances on the same Postgres and LocalStack', () => {
  test('two bets of 80 over 100, each to a different instance, on 20 wallets: one PROCESSED and one REJECTED per wallet', async () => {
    const book = new Book();
    const wallets = await Promise.all(range(20).map((i) => createWallet(instances[i % 3]!)));
    const results = await Promise.all(wallets.flatMap((wallet, i) => [0, 1].map(async (k) => ({
      wallet, result: await submit(instances[(i + k) % 3]!, wagerPayload(wallet, { money: brl('80.00') })),
    }))));

    for (const wallet of wallets) {
      book.open(wallet);
      book.debit(wallet, '80.00');
      const mine = results.filter((r) => r.wallet === wallet).map((r) => r.result).sort((a, b) => a.status - b.status);
      expect(new Set(mine.map((r) => r.instanceId)).size).toBe(2);
      expect(mine.map((r) => ({ status: r.status, tx: r.body.status, failureCode: r.body.failureCode }))).toEqual([
        { status: 200, tx: 'PROCESSED', failureCode: null },
        { status: 422, tx: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' },
      ]);
      expect(mine[0]!.body.balance).toEqual(brl('20.00'));
    }
    // Saldo 20.00, versão 2 e dois lançamentos: OPENING mais um único débito.
    await book.verify();
    await assertConverged();
  }, TEST_TIMEOUT_MS);

  test('the same bet 50 times spread across the 3 instances: a single debit, 49 replays', async () => {
    const book = new Book();
    const wallet = await createWallet(instances[0]!);
    book.open(wallet);
    const payload = wagerPayload(wallet, { money: brl('10.00') });
    const results = await Promise.all(range(50).map((i) => submit(instances[i % 3]!, payload)));

    expect(results.filter((r) => r.status !== 200)).toEqual([]);
    expect(new Set(results.map((r) => r.instanceId)).size).toBe(3);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => r.body.idempotentReplay === false).length).toBe(1);
    expect(results.every((r) => (r.body.balance as { amount: string }).amount === '90.00')).toBe(true);
    expect(await countTransactions([payload.externalTransactionId as string])).toBe(1);

    book.debit(wallet, '10.00');
    await book.verify();
    await assertConverged();
  }, TEST_TIMEOUT_MS);

  test('distinct wallets in parallel on the 3 instances, over HTTP and the queue; every instance serves and consumes', async () => {
    const book = new Book();
    const wallets = await Promise.all(range(9).map((i) => createWallet(instances[i % 3]!)));
    for (const wallet of wallets) book.open(wallet);

    const messages = wallets.flatMap((wallet) => range(5).map(() => betMessage(wallet, '5.00')));
    const [httpResults] = await Promise.all([
      Promise.all(wallets.flatMap((wallet, i) => range(10).map((j) =>
        submit(instances[(i + j) % 3]!, wagerPayload(wallet, { money: brl('5.00') }))))),
      sendToQueue(messages),
    ]);
    expect(httpResults.filter((r) => r.status !== 200)).toEqual([]);
    await waitForTransactions(messages.map((m) => m.externalId));
    // 10 por HTTP e 5 pela fila, de 5.00 cada, sobre 100.00: todas cabem, 25.00 no fim.
    for (const wallet of wallets) for (const _ of range(15)) book.debit(wallet, '5.00');

    await ensureEveryInstanceConsumed(instances, book);
    assertEveryInstanceServedHttp(instances);
    await assertQueuesEmpty();
    await book.verify();
    await assertConverged();
  }, TEST_TIMEOUT_MS);

  test('REFUND sent to one instance before its BET reaches another: both converge to PROCESSED', async () => {
    const book = new Book();
    const wallets = await Promise.all(range(6).map((i) => createWallet(instances[i % 3]!)));
    await Promise.all(wallets.map(async (wallet, i) => {
      book.open(wallet);
      const bet = wagerPayload(wallet, { money: brl('15.00') });
      const refund = wagerPayload(wallet, {
        kind: 'REFUND', money: brl('15.00'), referenceExternalTransactionId: bet.externalTransactionId,
      });

      const pending = await submit(instances[i % 3]!, refund);
      expect({ status: pending.status, tx: pending.body.status }).toEqual({ status: 202, tx: 'PENDING_REFERENCE' });
      const placed = await submit(instances[(i + 1) % 3]!, bet);
      expect({ status: placed.status, tx: placed.body.status }).toEqual({ status: 200, tx: 'PROCESSED' });

      // O worker de alguma das três instâncias resolve; a consulta vai a uma terceira.
      const resolved = await waitFor(
        () => call(instances[(i + 2) % 3]!, 'GET', `/wagering/transactions/${pending.body.transactionId as string}`),
        (r) => r.body.status !== 'PENDING_REFERENCE',
        30_000,
      );
      expect({ status: resolved.body.status, failureCode: resolved.body.failureCode }).toEqual({ status: 'PROCESSED', failureCode: null });
      book.debit(wallet, '15.00');
      book.credit(wallet, '15.00');
    }));
    await book.verify();
    await assertConverged();
  }, TEST_TIMEOUT_MS);

  test('crash: one instance is killed with work in flight; the other two finish everything, no loss, no duplicate', async () => {
    const book = new Book();
    const [first, victim, third] = instances as [Instance, Instance, Instance];
    const survivors = [first, third];
    const wallets = await Promise.all(range(8).map((i) => createWallet(survivors[i % 2]!)));
    for (const wallet of wallets) book.open(wallet);

    const httpBets: Record<string, unknown>[] = [];
    const sent: SentMessage[] = [];
    let duplicates = 0;
    const loadRound = async (): Promise<void> => {
      const messages = range(8).map((i) => betMessage(wallets[i]!, '1.00'));
      sent.push(...messages);
      for (const [i] of messages.entries()) book.debit(wallets[i]!, '1.00');
      // Redelivery: as 4 primeiras de novo, com o mesmo messageId (o FIFO aceita por ter outro dedup id).
      duplicates += 4;
      const sending = sendToQueue([...messages, ...messages.slice(0, 4)]);
      const bets = range(60).map((i) => wagerPayload(wallets[i % 8]!, { money: brl('1.00') }));
      httpBets.push(...bets);
      for (const [i] of bets.entries()) book.debit(wallets[i % 8]!, '1.00');
      const results = await Promise.all(bets.map((bet, i) => submitWithFailover(instances[i % 3]!, bet)));
      await sending;
      expect(results.filter((r) => r === undefined || r.status !== 200)).toEqual([]);
    };

    let killedWithWorkInFlight = false;
    for (let round = 0; round < 3 && !killedWithWorkInFlight; round++) {
      const load = loadRound();
      const seen = await waitForWorkInFlight([victim], 10_000);
      if (seen !== undefined) {
        const pendingAtKill = victim.pending;
        await victim.kill();
        killedWithWorkInFlight = true;
        console.info(`[multi-instance] crash: killed ${victim.id} with ${pendingAtKill} request(s) pending, `
          + `an open submission transaction and ${seen.messagesInFlight} message(s) in flight in the queue`);
      }
      await load;
    }
    expect(killedWithWorkInFlight).toBe(true);
    instances = [first, third, victim];

    // As mensagens que a morta tinha recebido voltam depois da visibilidade (12 s) e as vivas as processam.
    await waitForTransactions([...httpBets.map((b) => b.externalTransactionId as string), ...sent.map((m) => m.externalId)]);
    await assertQueuesEmpty();

    // Cada aposta lógica uma única vez e PROCESSED; a redelivery virou duplicata na inbox.
    const externalIds = [...httpBets.map((b) => b.externalTransactionId as string), ...sent.map((m) => m.externalId)];
    const [rows] = await sql(
      `SELECT count(*)::int AS total, count(DISTINCT external_transaction_id)::int AS distinct_ids,
              count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed
       FROM wager_transactions WHERE external_transaction_id IN (${placeholders(externalIds.length)})`,
      externalIds,
    );
    expect(rows).toEqual({ total: externalIds.length, distinct_ids: externalIds.length, processed: externalIds.length });
    const [inbox] = await sql(
      `SELECT count(*)::int AS n FROM inbox WHERE message_id IN (${placeholders(sent.length)})`,
      sent.map((m) => m.messageId),
    );
    expect(inbox!.n).toBe(sent.length);
    expect(duplicates).toBeGreaterThan(0);
    console.info(`[multi-instance] crash: ${failovers} HTTP request(s) failed over, ${failoverReplays} of them replays`);

    await book.verify();
    await assertConverged();
    // A substituta sobe e fica pronta: o próximo cenário começa de novo com três vivas.
    instances = [first, third, await spawn()];
  }, TEST_TIMEOUT_MS);

  test('full restart: all 3 killed mid-load, 3 new ones on the same database reach a consistent final state', async () => {
    const book = new Book();
    const old = [...instances];
    const wallets = await Promise.all(range(6).map((i) => createWallet(old[i % 3]!)));
    for (const wallet of wallets) book.open(wallet);

    // Reversões que chegam antes da BET: ficam PENDING_REFERENCE até depois do reinício.
    const missingBets = wallets.slice(0, 4).map((wallet) => wagerPayload(wallet, { money: brl('7.00') }));
    const refunds = await Promise.all(missingBets.map(async (bet, i) => {
      const refund = wagerPayload(wallets[i]!, {
        kind: 'REFUND', money: brl('7.00'), referenceExternalTransactionId: bet.externalTransactionId,
      });
      const result = await submit(old[i % 3]!, refund);
      expect(result.status).toBe(202);
      return result.body.transactionId as string;
    }));
    for (const wallet of wallets.slice(0, 4)) {
      book.debit(wallet, '7.00');
      book.credit(wallet, '7.00');
    }

    const httpBets: Record<string, unknown>[] = [];
    const deferred: Record<string, unknown>[] = [];
    const sent: SentMessage[] = [];
    const loadRound = async (): Promise<void> => {
      const messages = range(12).map((i) => betMessage(wallets[i % 6]!, '1.00'));
      sent.push(...messages);
      for (const [i] of messages.entries()) book.debit(wallets[i % 6]!, '1.00');
      const sending = sendToQueue([...messages, ...messages.slice(0, 6)]);
      const bets = range(45).map((i) => wagerPayload(wallets[i % 6]!, { money: brl('1.00') }));
      httpBets.push(...bets);
      for (const [i] of bets.entries()) book.debit(wallets[i % 6]!, '1.00');
      const results = await Promise.all(bets.map(async (bet, i) => {
        const result = await submitWithFailover(old[i % 3]!, bet);
        if (result === undefined) deferred.push(bet); // nenhuma viva: o cliente reenvia depois do reinício
        return result;
      }));
      await sending;
      expect(results.filter((r) => r !== undefined && r.status !== 200)).toEqual([]);
    };

    let killedWithWorkInFlight = false;
    for (let round = 0; round < 3 && !killedWithWorkInFlight; round++) {
      const load = loadRound();
      const seen = await waitForWorkInFlight(old, 10_000);
      if (seen !== undefined) {
        await Promise.all(old.map((instance) => instance.kill()));
        killedWithWorkInFlight = true;
        console.info(`[multi-instance] restart: killed all 3 with ${seen.instance.id} mid-transaction and `
          + `${seen.messagesInFlight} message(s) in flight in the queue`);
      }
      await load;
    }
    expect(killedWithWorkInFlight).toBe(true);

    // Com tudo parado: as BETs que faltavam, mais apostas e redeliveries (mesmo messageId) entram na fila.
    const whileDown = [
      ...missingBets.map((bet) => {
        const body = envelope(bet);
        return { body, messageId: body.messageId as string, externalId: bet.externalTransactionId as string };
      }),
      ...range(10).map((i) => betMessage(wallets[i % 6]!, '1.00')),
    ];
    for (const [i] of range(10).entries()) book.debit(wallets[i % 6]!, '1.00');
    sent.push(...whileDown);
    await sendToQueue([...whileDown, ...whileDown.slice(0, 5), ...sent.slice(0, 5)]);

    // O Postgres soltou as sessões (e os locks) das mortas antes de as novas subirem.
    await waitFor(() => sessionsOf(old.map((i) => i.applicationName)), (n) => n === 0, 15_000);

    instances = await Promise.all([0, 1, 2].map(() => spawn()));
    // O cliente reenvia o que ficou sem resposta, com a mesma key, e manda algumas apostas novas a cada nova.
    const retried = await Promise.all(deferred.map((bet, i) => submit(instances[i % 3]!, bet)));
    expect(retried.filter((r) => r.status !== 200)).toEqual([]);
    const fresh = range(6).map((i) => wagerPayload(wallets[i % 6]!, { money: brl('1.00') }));
    for (const [i] of fresh.entries()) book.debit(wallets[i % 6]!, '1.00');
    const freshResults = await Promise.all(fresh.map((bet, i) => submit(instances[i % 3]!, bet)));
    expect(freshResults.filter((r) => r.status !== 200)).toEqual([]);
    httpBets.push(...fresh);

    const externalIds = [
      ...httpBets.map((b) => b.externalTransactionId as string),
      ...sent.map((m) => m.externalId),
    ];
    await waitForTransactions(externalIds);
    await waitFor(
      () => sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE id IN (${placeholders(refunds.length)}) AND status = 'PROCESSED'`, refunds),
      (rows) => rows[0]!.n === refunds.length,
      30_000,
    );
    await ensureEveryInstanceConsumed(instances, book);
    assertEveryInstanceServedHttp(instances);
    await assertQueuesEmpty();

    const [rows] = await sql(
      `SELECT count(*)::int AS total, count(DISTINCT external_transaction_id)::int AS distinct_ids,
              count(*) FILTER (WHERE status = 'PROCESSED')::int AS processed
       FROM wager_transactions WHERE external_transaction_id IN (${placeholders(externalIds.length)})`,
      externalIds,
    );
    expect(rows).toEqual({ total: externalIds.length, distinct_ids: externalIds.length, processed: externalIds.length });
    const messageIds = [...new Set(sent.map((m) => m.messageId))];
    const [inbox] = await sql(`SELECT count(*)::int AS n FROM inbox WHERE message_id IN (${placeholders(messageIds.length)})`, messageIds);
    expect(inbox!.n).toBe(messageIds.length);
    const [pendingLeft] = await sql(`SELECT count(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`);
    expect(pendingLeft!.n).toBe(0);

    await book.verify();
    await assertConverged();
  }, TEST_TIMEOUT_MS);
});
