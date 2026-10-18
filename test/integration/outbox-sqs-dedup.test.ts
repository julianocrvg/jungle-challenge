import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageBatchCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { createTempFifoQueue, deleteQueue, receiveAll, SQS } from './support/outbox';

/*
 * Teste de fumaça (ARCHITECTURE 6.1): o LocalStack deduplica por MessageDeduplicationId? Os testes de crash e de
 * concorrência dependem disso para exigir "cada eventId exatamente uma vez" em vez de "nenhum perdido".
 */
describe('LocalStack FIFO deduplication', () => {
  let client: SQSClient;
  let queueUrl: string;

  beforeAll(async () => {
    client = createSqsClient(SQS);
    queueUrl = await createTempFifoQueue(client, 'dedup-smoke');
  });

  afterAll(async () => {
    await deleteQueue(client, queueUrl);
    client.destroy();
  });

  test('a resend with the same MessageDeduplicationId is accepted and dropped', async () => {
    const eventId = Bun.randomUUIDv7();
    const body = JSON.stringify({ eventId });
    await client.send(new SendMessageCommand({
      QueueUrl: queueUrl, MessageBody: body, MessageGroupId: 'wallet-1', MessageDeduplicationId: eventId,
    }));
    // O reenvio do publisher usa SendMessageBatch: tem de voltar como sucesso, não como falha da entrada.
    const resend = await client.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: [{ Id: eventId, MessageBody: body, MessageGroupId: 'wallet-1', MessageDeduplicationId: eventId }],
    }));
    expect(resend.Successful?.map((e) => e.Id)).toEqual([eventId]);
    expect(resend.Failed ?? []).toEqual([]);

    const received = await receiveAll(client, queueUrl, 1);
    expect(received.map((e) => e.eventId)).toEqual([eventId]);
  });
});
