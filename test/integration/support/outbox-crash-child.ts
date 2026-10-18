/*
 * Processo filho do teste de crash (outbox-concurrency.test.ts): roda um tick do publisher real e, depois que o
 * SQS aceitou o lote mas antes do commit que grava published_at, avisa o pai pelo stdout e fica parado.
 * O pai então mata o processo, simulando um crash entre publicar e marcar.
 *
 * Uso: bun test/integration/support/outbox-crash-child.ts <queueUrl>
 */
import { MikroORM } from '@mikro-orm/postgresql';
import type { EventPublisher, PublishResult } from '../../../src/application/ports/event-publisher';
import type { OutboxMessage } from '../../../src/domain/outbox-message';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL } from './database';
import { outboxPublisher, sqsPublisher } from './outbox';

const queueUrl = process.argv[2];
if (queueUrl === undefined) throw new Error('usage: outbox-crash-child.ts <queueUrl>');

class CrashAfterSend implements EventPublisher {
  constructor(private readonly inner: EventPublisher) {}

  async publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult> {
    const result = await this.inner.publish(messages, signal);
    process.stdout.write(`SENT ${JSON.stringify(result.published)}\n`);
    return new Promise<PublishResult>(() => {}); // nunca volta: a transação fica aberta até o processo morrer
  }
}

const orm = await MikroORM.init(createOrmConfig(TEST_DATABASE_URL));
const { batch } = outboxPublisher({
  orm,
  publisher: new CrashAfterSend(sqsPublisher(queueUrl)),
  sendTimeoutMs: 60_000, // o pai mata o processo bem antes; o timeout não pode decidir o teste
  idleInTransactionTimeoutMs: 180_000,
});
process.stdout.write('READY\n');
await batch.execute();
