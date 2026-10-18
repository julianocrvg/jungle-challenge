import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { MessageQueue } from '../../../src/application/ports/message-queue';
import { SubmitWagerTransaction } from '../../../src/application/wagering/submit-wager-transaction';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../../src/domain/pending-reference-policy';
import { BunIdGenerator } from '../../../src/infrastructure/id/bun-id-generator';
import { SqsMessageQueue } from '../../../src/infrastructure/messaging/sqs-message-queue';
import { InMemoryMetrics } from '../../../src/infrastructure/metrics/in-memory-metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import {
  type WagerConsumerOptions,
  WagerTransactionsConsumer,
} from '../../../src/interface/workers/wager-transactions-consumer.worker';
import type { WalletFixture } from './database';
import { CapturingStructuredLogger, SQS } from './outbox';

export const MAX_ATTEMPTS = 3;

export interface QueuePair {
  queueUrl: string;
  dlqUrl: string;
}

/** Fila e DLQ FIFO só deste arquivo de teste, com redrive de 3x o limite de tentativas (ARCHITECTURE 7.4). */
export async function createTempQueuePair(client: SQSClient, prefix: string, maxReceiveCount = 3 * MAX_ATTEMPTS): Promise<QueuePair> {
  const suffix = Bun.randomUUIDv7();
  const dlqName = `${prefix}-dlq-${suffix}.fifo`;
  await client.send(new CreateQueueCommand({
    QueueName: dlqName,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }));
  const dlqUrl = `${SQS.endpoint}/000000000000/${dlqName}`;
  const arn = (await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] })))
    .Attributes?.QueueArn;
  const name = `${prefix}-${suffix}.fifo`;
  await client.send(new CreateQueueCommand({
    QueueName: name,
    Attributes: {
      FifoQueue: 'true',
      ContentBasedDeduplication: 'false',
      VisibilityTimeout: '30',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: String(maxReceiveCount) }),
    },
  }));
  return { queueUrl: `${SQS.endpoint}/000000000000/${name}`, dlqUrl };
}

export function betData(wallet: WalletFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export function envelope(data: Record<string, unknown>, messageId = `msg-${Bun.randomUUIDv7()}`): Record<string, unknown> {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
}

export interface OutgoingMessage {
  body: string | Record<string, unknown>;
  groupId: string;
  /** Default: um id novo por envio. Repetir o mesmo faria o FIFO descartar a cópia. */
  deduplicationId?: string;
}

/** Envia em lotes de 10, na ordem dada. */
export async function sendMessages(client: SQSClient, queueUrl: string, messages: OutgoingMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 10) {
    const output = await client.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: messages.slice(i, i + 10).map((m, j) => ({
        Id: String(j),
        MessageBody: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
        MessageGroupId: m.groupId,
        MessageDeduplicationId: m.deduplicationId ?? Bun.randomUUIDv7(),
      })),
    }));
    if ((output.Failed ?? []).length > 0) throw new Error(`send failed: ${JSON.stringify(output.Failed)}`);
  }
}

export interface DeadLetterMessage {
  body: string;
  groupId: string;
  reason: string;
  detail: string;
}

/** Lê e apaga a DLQ até `expected` mensagens, e faz mais uma leitura para provar que não sobrou nenhuma. */
export async function receiveDeadLetters(client: SQSClient, dlqUrl: string, expected: number, timeoutMs = 20_000): Promise<DeadLetterMessage[]> {
  const received: DeadLetterMessage[] = [];
  const deadline = Date.now() + timeoutMs;
  while (received.length < expected && Date.now() < deadline) received.push(...await receiveAndDelete(client, dlqUrl));
  received.push(...await receiveAndDelete(client, dlqUrl));
  return received;
}

async function receiveAndDelete(client: SQSClient, queueUrl: string): Promise<DeadLetterMessage[]> {
  const output = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
    MessageSystemAttributeNames: ['MessageGroupId'],
    MessageAttributeNames: ['All'],
  }));
  const messages = output.Messages ?? [];
  if (messages.length === 0) return [];
  await client.send(new DeleteMessageBatchCommand({
    QueueUrl: queueUrl,
    Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
  }));
  return messages.map((m) => ({
    body: m.Body ?? '',
    groupId: m.Attributes?.MessageGroupId ?? '',
    reason: m.MessageAttributes?.failureReason?.StringValue ?? '',
    detail: m.MessageAttributes?.failureDetail?.StringValue ?? '',
  }));
}

/** Mensagens visíveis + em voo. Zero: a fila esvaziou. */
export async function queueDepth(client: SQSClient, queueUrl: string): Promise<number> {
  const output = await client.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  const a = output.Attributes ?? {};
  return Number.parseInt(a.ApproximateNumberOfMessages ?? '0', 10) + Number.parseInt(a.ApproximateNumberOfMessagesNotVisible ?? '0', 10);
}

export const TEST_CONSUMER_OPTIONS: WagerConsumerOptions = {
  enabled: true,
  consumerName: 'wager-transactions',
  maxAttempts: MAX_ATTEMPTS,
  waitTimeSeconds: 1,
  visibilityTimeoutSeconds: 30,
  concurrency: 5,
  backoff: { baseMs: 1_000, maxMs: 1_000 },
  unexpectedBackoff: { baseMs: 1_000, maxMs: 1_000 },
  processingBudgetMs: 15_000,
  receiveErrorDelayMs: 200,
  redriveSafetyFactor: 3,
};

export interface ConsumerSetup {
  orm: MikroORM;
  queues: QueuePair;
  client: SQSClient;
  lockTimeoutMs?: number;
  options?: Partial<WagerConsumerOptions>;
  /** Para injetar falhas: recebe o use case real e devolve o que o consumidor vai chamar. */
  wrapSubmit?: (submit: SubmitWagerTransaction) => SubmitWagerTransaction;
  wrapQueue?: (queue: MessageQueue) => MessageQueue;
}

/** Coleta as linhas do stdout de um processo filho desde o início, sem perder nenhuma entre esperas. */
export class ChildOutput {
  readonly lines: string[] = [];

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.pump(stream);
  }

  async line(match: RegExp, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.lines.find((l) => match.test(l));
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`child never printed ${match}; got: ${this.lines.join(' | ')}`);
      await Bun.sleep(25);
    }
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      this.lines.push(...parts);
    }
  }
}

/** Transação externa que segura o FOR UPDATE da wallet até `release()` (mesmo padrão de wallet-lock-order). */
export async function holdWalletLock(orm: MikroORM, walletId: string): Promise<{ release: () => Promise<void> }> {
  const { promise: locked, resolve: signalLocked } = Promise.withResolvers<void>();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const transaction = orm.em.fork().transactional(async (em) => {
    await em.execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [walletId]);
    signalLocked();
    await released;
  });
  await locked;
  return {
    release: async () => {
      release();
      await transaction;
    },
  };
}

/** Um consumidor como o de uma instância: use case real, Postgres e SQS reais. */
export function buildConsumer(setup: ConsumerSetup): {
  consumer: WagerTransactionsConsumer; metrics: InMemoryMetrics; logger: CapturingStructuredLogger; submit: SubmitWagerTransaction;
} {
  const metrics = new InMemoryMetrics();
  const logger = new CapturingStructuredLogger();
  const real = new SubmitWagerTransaction(
    new MikroOrmUnitOfWork(setup.orm, setup.lockTimeoutMs ?? 10_000), new BunIdGenerator(), { now: () => new Date() },
    DEFAULT_PENDING_REFERENCE_POLICY,
  );
  const submit = setup.wrapSubmit?.(real) ?? real;
  const sqsQueue = new SqsMessageQueue(setup.client, setup.queues.queueUrl, setup.queues.dlqUrl);
  const queue = setup.wrapQueue?.(sqsQueue) ?? sqsQueue;
  const consumer = new WagerTransactionsConsumer(submit, queue, metrics, logger, { ...TEST_CONSUMER_OPTIONS, ...setup.options });
  return { consumer, metrics, logger, submit: real };
}
