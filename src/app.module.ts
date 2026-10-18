import { type DynamicModule, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PublishOutboxBatch } from './application/outbox/publish-outbox-batch';
import { CLOCK, type Clock } from './application/ports/clock';
import { EVENT_PUBLISHER, type EventPublisher } from './application/ports/event-publisher';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator';
import { METRICS, type Metrics } from './application/ports/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work';
import { ResolvePendingReference } from './application/wagering/resolve-pending-reference';
import { SubmitWagerTransaction } from './application/wagering/submit-wager-transaction';
import { CreateWallet } from './application/wallets/create-wallet';
import {
  type DatabaseSettings,
  databaseSettingsFromEnv,
  type OutboxSettings,
  outboxSettingsFromEnv,
  type SqsSettings,
  sqsSettingsFromEnv,
  validateOutboxSettings,
} from './config';
import { DEFAULT_BACKOFF } from './domain/backoff';
import { SystemClock } from './infrastructure/clock/system-clock';
import { BunIdGenerator } from './infrastructure/id/bun-id-generator';
import { NestStructuredLogger } from './infrastructure/logging/nest-structured-logger';
import { createSqsClient, SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { InMemoryMetrics } from './infrastructure/metrics/in-memory-metrics';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { HealthController } from './interface/http/health.controller';
import { WageringTransactionsController } from './interface/http/wagering-transactions.controller';
import { WalletsController } from './interface/http/wallets.controller';
import { OutboxPublisherWorker } from './interface/workers/outbox-publisher.worker';

/** Pontos de substituição para testes: banco, SQS, outbox, gerador de ids, relógio, broker e métricas. */
export interface AppOptions {
  database?: Partial<DatabaseSettings>;
  sqs?: Partial<SqsSettings>;
  outbox?: Partial<OutboxSettings>;
  idGenerator?: IdGenerator;
  clock?: Clock;
  eventPublisher?: EventPublisher;
  metrics?: Metrics;
}

// Os use cases não conhecem o Nest: são montados aqui por factory, sem decorators na camada de aplicação.
@Module({})
export class AppModule {
  static forRoot(options: AppOptions = {}): DynamicModule {
    const database = { ...databaseSettingsFromEnv(), ...options.database };
    const sqs = { ...sqsSettingsFromEnv(), ...options.sqs };
    const outbox = { ...outboxSettingsFromEnv(), ...options.outbox };
    validateOutboxSettings(outbox);
    const useCaseDeps = [UNIT_OF_WORK, ID_GENERATOR, CLOCK];
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmConfig(database.url, { poolMax: database.poolMax }))],
      controllers: [HealthController, WalletsController, WageringTransactionsController],
      providers: [
        { provide: ID_GENERATOR, useValue: options.idGenerator ?? new BunIdGenerator() },
        { provide: CLOCK, useValue: options.clock ?? new SystemClock() },
        { provide: METRICS, useValue: options.metrics ?? new InMemoryMetrics() },
        {
          provide: EVENT_PUBLISHER,
          useFactory: () => options.eventPublisher ?? new SqsEventPublisher(createSqsClient(sqs), sqs.eventsQueueUrl),
        },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, database.lockTimeoutMs),
          inject: [MikroORM],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new CreateWallet(uow, ids, clock),
          inject: useCaseDeps,
        },
        {
          provide: SubmitWagerTransaction,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new SubmitWagerTransaction(uow, ids, clock),
          inject: useCaseDeps,
        },
        {
          provide: ResolvePendingReference,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new ResolvePendingReference(uow, ids, clock),
          inject: useCaseDeps,
        },
        {
          provide: PublishOutboxBatch,
          useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, metrics: Metrics) =>
            new PublishOutboxBatch(uow, publisher, clock, metrics, new NestStructuredLogger('OutboxPublisher'), {
              batchSize: outbox.batchSize,
              sendTimeoutMs: outbox.sendTimeoutMs,
              idleInTransactionTimeoutMs: outbox.idleInTransactionTimeoutMs,
              backoff: DEFAULT_BACKOFF,
            }),
          inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, METRICS],
        },
        {
          provide: OutboxPublisherWorker,
          useFactory: (publishBatch: PublishOutboxBatch, metrics: Metrics) =>
            new OutboxPublisherWorker(publishBatch, metrics, new NestStructuredLogger('OutboxPublisher'), {
              enabled: outbox.enabled,
              batchSize: outbox.batchSize,
              pollIntervalMs: outbox.pollIntervalMs,
            }),
          inject: [PublishOutboxBatch, METRICS],
        },
      ],
    };
  }
}
