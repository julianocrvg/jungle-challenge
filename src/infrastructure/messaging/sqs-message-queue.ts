import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type {
  DeadLetter,
  MessageQueue,
  ReceivedMessage,
  ReceiveOptions,
} from '../../application/ports/message-queue';

/** Atributos de mensagem do SQS aceitam até 256 KB, mas o detalhe é só para diagnóstico. */
const MAX_DETAIL_LENGTH = 256;

/**
 * Adaptador da fila FIFO de entrada (ARCHITECTURE 7). O cliente é o de `createSqsClient` (`maxAttempts: 1`):
 * o retry de uma mensagem é a própria redelivery do SQS, com o backoff aplicado pela visibilidade.
 */
export class SqsMessageQueue implements MessageQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly deadLetterQueueUrl: string,
  ) {}

  async receive(options: ReceiveOptions, signal: AbortSignal): Promise<ReceivedMessage[]> {
    const output = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: options.maxMessages,
      WaitTimeSeconds: options.waitTimeSeconds,
      VisibilityTimeout: options.visibilityTimeoutSeconds,
      MessageSystemAttributeNames: ['MessageGroupId', 'ApproximateReceiveCount'],
    }), { abortSignal: signal });
    const receivedAt = Date.now();
    return (output.Messages ?? []).map((m) => ({
      transportId: m.MessageId ?? '',
      receiptHandle: m.ReceiptHandle ?? '',
      body: m.Body ?? '',
      groupId: m.Attributes?.MessageGroupId ?? '',
      receiveCount: Number.parseInt(m.Attributes?.ApproximateReceiveCount ?? '1', 10),
      receivedAt,
    }));
  }

  async delete(message: ReceivedMessage): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.receiptHandle }));
  }

  async changeVisibility(message: ReceivedMessage, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.receiptHandle,
      VisibilityTimeout: seconds,
    }));
  }

  /**
   * Mesmo corpo e mesmo `MessageGroupId` da original, para que reenviar da DLQ para a fila preserve o grupo
   * (ARCHITECTURE 7.6). `MessageDeduplicationId` = `MessageId` do SQS: se o processo morrer entre esta cópia e o
   * ack, a redelivery copia de novo e o FIFO da DLQ descarta a segunda (janela de 5 min).
   */
  async sendToDeadLetter(message: ReceivedMessage, letter: DeadLetter): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.deadLetterQueueUrl,
      MessageBody: message.body,
      MessageGroupId: message.groupId,
      MessageDeduplicationId: message.transportId,
      MessageAttributes: {
        failureReason: { DataType: 'String', StringValue: letter.reason },
        failureDetail: { DataType: 'String', StringValue: letter.detail.slice(0, MAX_DETAIL_LENGTH) || '-' },
        sourceMessageId: { DataType: 'String', StringValue: message.transportId },
        receiveCount: { DataType: 'Number', StringValue: String(message.receiveCount) },
      },
    }));
  }

  async redriveMaxReceiveCount(): Promise<number | undefined> {
    const output = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: this.queueUrl,
      AttributeNames: ['RedrivePolicy'],
    }));
    const policy = output.Attributes?.RedrivePolicy;
    if (policy === undefined) return undefined;
    const parsed = JSON.parse(policy) as { maxReceiveCount?: unknown };
    const value = Number.parseInt(String(parsed.maxReceiveCount), 10);
    return Number.isNaN(value) ? undefined : value;
  }

  /** Hook do Nest: fecha as conexões HTTP do cliente depois que o consumidor parou. */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
