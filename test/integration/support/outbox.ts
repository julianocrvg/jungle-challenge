import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutboxBatch } from '../../../src/application/outbox/publish-outbox-batch';
import type { Clock } from '../../../src/application/ports/clock';
import type { EventPublisher, PublishResult } from '../../../src/application/ports/event-publisher';
import type { LogFields, StructuredLogger } from '../../../src/application/ports/structured-logger';
import type { UnitOfWork } from '../../../src/application/ports/unit-of-work';
import { type SqsSettings, sqsSettingsFromEnv } from '../../../src/config';
import type { OutboxMessage } from '../../../src/domain/outbox-message';
import { createSqsClient, SqsEventPublisher } from '../../../src/infrastructure/messaging/sqs-event-publisher';
import { InMemoryMetrics } from '../../../src/infrastructure/metrics/in-memory-metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import type { Sql } from './database';

export const SQS: SqsSettings = sqsSettingsFromEnv();
export const TEST_BACKOFF = { baseMs: 1_000, maxMs: 60_000 };

export class ManualClock implements Clock {
  constructor(public current: Date = new Date()) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class CapturingStructuredLogger implements StructuredLogger {
  readonly entries: { level: string; message: string; fields: LogFields }[] = [];
  info(message: string, fields: LogFields = {}): void { this.entries.push({ level: 'info', message, fields }); }
  warn(message: string, fields: LogFields = {}): void { this.entries.push({ level: 'warn', message, fields }); }
  error(message: string, fields: LogFields = {}): void { this.entries.push({ level: 'error', message, fields }); }
}

/** Fila FIFO só deste teste: sem ruído de outros testes e sem depender de PurgeQueue. */
export async function createTempFifoQueue(client: SQSClient, prefix: string): Promise<string> {
  const name = `${prefix}-${Bun.randomUUIDv7()}.fifo`;
  await client.send(new CreateQueueCommand({
    QueueName: name,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }));
  return `${SQS.endpoint}/000000000000/${name}`;
}

export async function deleteQueue(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
}

export interface ReceivedEvent {
  eventId: string;
  eventType: string;
  groupId: string;
  deduplicationId: string;
  body: Record<string, unknown>;
}

/**
 * Lê e apaga mensagens até chegar a `expected`, com prazo. Depois faz mais uma leitura com long polling para
 * provar que não sobrou nenhuma a mais (uma duplicata apareceria aqui).
 */
export async function receiveAll(
  client: SQSClient, queueUrl: string, expected: number, timeoutMs = 20_000,
): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (received.length < expected && Date.now() < deadline) {
    received.push(...await receiveBatch(client, queueUrl));
  }
  received.push(...await receiveBatch(client, queueUrl));
  return received;
}

async function receiveBatch(client: SQSClient, queueUrl: string): Promise<ReceivedEvent[]> {
  const output = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
    VisibilityTimeout: 60,
    MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
    MessageAttributeNames: ['All'],
  }));
  const messages = output.Messages ?? [];
  if (messages.length === 0) return [];
  await client.send(new DeleteMessageBatchCommand({
    QueueUrl: queueUrl,
    Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
  }));
  return messages.map((m) => {
    const body = JSON.parse(m.Body ?? '{}') as Record<string, unknown>;
    return {
      eventId: body.eventId as string,
      eventType: m.MessageAttributes?.eventType?.StringValue ?? '',
      groupId: m.Attributes?.MessageGroupId ?? '',
      deduplicationId: m.Attributes?.MessageDeduplicationId ?? '',
      body,
    };
  });
}

/** Conta cada envio aceito pelo broker, por eventId (prova de que o SKIP LOCKED não deixou ninguém enviar duas vezes). */
export class CountingPublisher implements EventPublisher {
  readonly sent: string[] = [];
  constructor(private readonly inner: EventPublisher) {}

  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    const result = await this.inner.publish(messages, signal);
    this.sent.push(...result.published);
    return result;
  }
}

/** Atrasa o envio real: simula um broker lento. */
export class DelayedPublisher implements EventPublisher {
  constructor(private readonly inner: EventPublisher, private readonly delayMs: number) {}

  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    await Bun.sleep(this.delayMs);
    return this.inner.publish(messages, signal);
  }
}

export function sqsPublisher(queueUrl: string, settings: Partial<SqsSettings> = {}): SqsEventPublisher {
  return new SqsEventPublisher(createSqsClient({ ...SQS, ...settings }), queueUrl);
}

export interface PublisherSetup {
  orm: MikroORM;
  publisher: EventPublisher;
  clock?: Clock;
  sendTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  batchSize?: number;
  /** Decorator sobre o UnitOfWork real (ex.: derrubar a sessão antes do COMMIT). */
  wrapUow?: (real: UnitOfWork) => UnitOfWork;
}

/** Um publisher como o de uma instância: ORM (pool) próprio, broker e relógio injetados. */
export function outboxPublisher(setup: PublisherSetup): {
  batch: PublishOutboxBatch; metrics: InMemoryMetrics; logger: CapturingStructuredLogger;
} {
  const metrics = new InMemoryMetrics();
  const logger = new CapturingStructuredLogger();
  const real = new MikroOrmUnitOfWork(setup.orm, 10_000);
  const batch = new PublishOutboxBatch(
    setup.wrapUow?.(real) ?? real,
    setup.publisher,
    setup.clock ?? { now: () => new Date() },
    metrics,
    logger,
    {
      batchSize: setup.batchSize ?? 10,
      sendTimeoutMs: setup.sendTimeoutMs ?? 5_000,
      idleInTransactionTimeoutMs: setup.idleInTransactionTimeoutMs ?? 15_000,
      backoff: TEST_BACKOFF,
    },
  );
  return { batch, metrics, logger };
}

/** Roda ticks até um vir vazio. Devolve quantas mensagens este publisher publicou. */
export async function drain(batch: PublishOutboxBatch): Promise<number> {
  let published = 0;
  for (;;) {
    const result = await batch.execute();
    published += result.published;
    if (result.claimed === 0) return published;
  }
}

export async function outboxIds(sql: Sql): Promise<Set<string>> {
  return new Set((await sql(`SELECT id FROM outbox`)).map((row) => row.id as string));
}

/** Eventos ainda não publicados. Ao fim de cada teste: esperado nenhum. */
export async function pendingOutbox(sql: Sql): Promise<Record<string, unknown>[]> {
  return sql(`SELECT id, attempts, next_attempt_at FROM outbox WHERE published_at IS NULL`);
}

/** Polling com prazo, sem sleep arbitrário: repete `probe` até `done` ser verdadeiro. */
export async function waitFor<T>(probe: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out; last value: ${JSON.stringify(value)}`);
    await Bun.sleep(50);
  }
}

/** Cada id exatamente uma vez. */
export function countById(events: readonly { eventId: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.eventId, (counts.get(event.eventId) ?? 0) + 1);
  return counts;
}
