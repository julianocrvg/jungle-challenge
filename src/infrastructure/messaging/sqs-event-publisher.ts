import {
  SendMessageBatchCommand,
  type SendMessageBatchCommandOutput,
  type SendMessageBatchRequestEntry,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/ports/event-publisher';
import type { SqsSettings } from '../../config';
import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * Cliente sem retry interno (`maxAttempts: 1`): o retry é o backoff da outbox, que fica gravado no banco.
 * Com retry no SDK, o tempo de uma chamada ficaria imprevisível e somaria com o nosso.
 */
export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    maxAttempts: 1,
  });
}

/**
 * Entradas do SendMessageBatch (ARCHITECTURE 6.1):
 * - `Id` e `MessageDeduplicationId` = eventId: o reenvio do mesmo evento é descartado pelo FIFO (janela de 5 min);
 * - `MessageGroupId` = aggregateId (walletId): ordem por wallet como otimização; o consumidor usa walletVersion;
 * - corpo = envelope JSON do evento, e `eventType` como atributo para filtrar sem abrir o corpo.
 */
export function toBatchEntries(messages: readonly OutboxMessage[]): SendMessageBatchRequestEntry[] {
  return messages.map((message) => ({
    Id: message.id,
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: message.aggregateId,
    MessageDeduplicationId: message.id,
    MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
  }));
}

/** `SenderFault` distingue erro do remetente (payload, atributos) de erro do serviço. */
export function fromBatchOutput(output: Pick<SendMessageBatchCommandOutput, 'Successful' | 'Failed'>): PublishResult {
  return {
    published: (output.Successful ?? []).flatMap((entry) => (entry.Id === undefined ? [] : [entry.Id])),
    failed: (output.Failed ?? []).flatMap((entry) => (entry.Id === undefined ? [] : [{
      id: entry.Id,
      fault: entry.SenderFault === true ? 'sender' as const : 'service' as const,
      code: entry.Code ?? 'UNKNOWN',
      message: entry.Message ?? '',
    }])),
  };
}

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    const output = await this.client.send(
      new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: toBatchEntries(messages) }),
      { abortSignal: signal },
    );
    return fromBatchOutput(output);
  }

  /** Hook do Nest: fecha as conexões HTTP do cliente depois que o worker parou. */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
