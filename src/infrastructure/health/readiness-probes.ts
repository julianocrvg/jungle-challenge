import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { ReadinessProbe } from '../../interface/http/readiness';

/** `SELECT 1` por uma conexão do pool: prova que o banco aceita conexão e responde. */
export class PostgresReadinessProbe implements ReadinessProbe {
  readonly name = 'postgres';

  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    await (this.orm.em.fork() as EntityManager).execute('SELECT 1');
  }
}

/** Os probes de uma instância. Dono do cliente SQS dos probes: o fecha no shutdown, como os demais adaptadores. */
export class ReadinessProbeSet {
  constructor(
    readonly probes: readonly ReadinessProbe[],
    private readonly sqsClient: SQSClient,
  ) {}

  onApplicationShutdown(): void {
    this.sqsClient.destroy();
  }
}

/** `GetQueueAttributes` da fila: prova que o SQS responde e que a fila configurada existe. */
export class SqsQueueReadinessProbe implements ReadinessProbe {
  constructor(
    readonly name: string,
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async check(signal: AbortSignal): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }),
      { abortSignal: signal },
    );
  }
}
