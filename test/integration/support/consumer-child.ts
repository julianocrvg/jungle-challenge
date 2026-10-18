/*
 * Processo filho dos testes multi-processo do consumidor (uma "instância" separada, com pool próprio).
 *
 * Uso: bun test/integration/support/consumer-child.ts <mode> <queueUrl> <dlqUrl>
 *   crash-after-commit: processa, e no DeleteMessage (o commit já aconteceu) avisa "COMMITTED <sqsMessageId>" no
 *                       stdout e fica parado. O pai mata o processo: crash entre o commit e o ack.
 *   run:                consome até receber "STOP" no stdin; então faz o shutdown e imprime "METRICS <json>".
 */
import { MikroORM } from '@mikro-orm/postgresql';
import type { MessageQueue, ReceivedMessage } from '../../../src/application/ports/message-queue';
import { createSqsClient } from '../../../src/infrastructure/messaging/sqs-event-publisher';
import { createOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { buildConsumer } from './consumer';
import { TEST_DATABASE_URL } from './database';
import { SQS } from './outbox';

const [mode, queueUrl, dlqUrl] = process.argv.slice(2);
if (mode === undefined || queueUrl === undefined || dlqUrl === undefined) {
  throw new Error('usage: consumer-child.ts <crash-after-commit|run> <queueUrl> <dlqUrl>');
}

const crashOnAck = (inner: MessageQueue): MessageQueue => ({
  receive: (options, signal) => inner.receive(options, signal),
  changeVisibility: (message, seconds) => inner.changeVisibility(message, seconds),
  sendToDeadLetter: (message, letter) => inner.sendToDeadLetter(message, letter),
  redriveMaxReceiveCount: () => inner.redriveMaxReceiveCount(),
  delete: (message: ReceivedMessage) => {
    process.stdout.write(`COMMITTED ${message.transportId}\n`);
    return new Promise<void>(() => {}); // nunca faz o ack: o pai mata o processo aqui
  },
});

const orm = await MikroORM.init(createOrmConfig(TEST_DATABASE_URL));
const client = createSqsClient(SQS);
const crash = mode === 'crash-after-commit';
const { consumer, metrics } = buildConsumer({
  orm,
  client,
  queues: { queueUrl, dlqUrl },
  ...(crash ? { wrapQueue: crashOnAck } : {}),
  // Visibilidade curta no crash para a redelivery chegar logo ao pai; sem prazo de processamento nesse caso.
  options: crash ? { visibilityTimeoutSeconds: 2, processingBudgetMs: 0 } : { concurrency: 4 },
});
consumer.start();
process.stdout.write('READY\n');

if (!crash) {
  for await (const line of console) {
    if (line.trim() === 'STOP') break;
  }
  await consumer.stop();
  process.stdout.write(`METRICS ${JSON.stringify(metrics.counterSnapshot())}\n`);
  client.destroy();
  await orm.close(true);
  process.exit(0);
}
