import { type DynamicModule, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PublishOutboxBatch } from './application/outbox/publish-outbox-batch';
import { CLOCK, type Clock } from './application/ports/clock';
import { EVENT_PUBLISHER, type EventPublisher } from './application/ports/event-publisher';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator';
import { METRICS, type Metrics } from './application/ports/metrics';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work';
import { PendingReferenceQueries } from './application/wagering/pending-reference-queries';
import { ResolvePendingReference } from './application/wagering/resolve-pending-reference';
import { SubmitWagerTransaction } from './application/wagering/submit-wager-transaction';
import { CreateWallet } from './application/wallets/create-wallet';
import { GetLedgerPage } from './application/wallets/get-ledger-page';
import { GetWallet } from './application/wallets/get-wallet';
import { ReconcileWallet } from './application/wallets/reconcile-wallet';
import { WALLET_QUERIES, type WalletQueries } from './application/ports/wallet-queries';
import { SqlWalletQueries } from './infrastructure/persistence/sql-wallet-queries';
import { MESSAGE_QUEUE, type MessageQueue } from './application/ports/message-queue';
import {
  CONSUMER_NAME,
  type ConsumerSettings,
  consumerProcessingBudgetMs,
  consumerSettingsFromEnv,
  type DatabaseSettings,
  databaseSettingsFromEnv,
  type LedgerSettings,
  ledgerSettingsFromEnv,
  validateLedgerSettings,
  type OutboxSettings,
  outboxSettingsFromEnv,
  type PendingReferenceSettings,
  pendingReferenceSettingsFromEnv,
  type SqsSettings,
  sqsSettingsFromEnv,
  validateConsumerSettings,
  validateOutboxSettings,
  validatePendingReferenceSettings,
  validatePoolBudget,
} from './config';
import { DEFAULT_BACKOFF } from './domain/backoff';
import type { PendingReferencePolicy } from './domain/pending-reference-policy';
import { SqsMessageQueue } from './infrastructure/messaging/sqs-message-queue';
import { WagerTransactionsConsumer } from './interface/workers/wager-transactions-consumer.worker';
import { SystemClock } from './infrastructure/clock/system-clock';
import { BunIdGenerator } from './infrastructure/id/bun-id-generator';
import { NestStructuredLogger } from './infrastructure/logging/nest-structured-logger';
import { createSqsClient, SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { InMemoryMetrics } from './infrastructure/metrics/in-memory-metrics';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { HealthController } from './interface/http/health.controller';
import { ProviderTransactionsController, WageringTransactionsController } from './interface/http/wagering-transactions.controller';
import { GetWagerTransaction } from './application/wagering/get-wager-transaction';
import { WalletsController } from './interface/http/wallets.controller';
import { OutboxPublisherWorker } from './interface/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from './interface/workers/pending-reference.worker';

/** Pontos de substituição para testes: banco, SQS, outbox, gerador de ids, relógio, broker e métricas. */
export interface AppOptions {
  database?: Partial<DatabaseSettings>;
  sqs?: Partial<SqsSettings>;
  outbox?: Partial<OutboxSettings>;
  consumer?: Partial<ConsumerSettings>;
  pendingReference?: Partial<PendingReferenceSettings>;
  ledger?: Partial<LedgerSettings>;
  idGenerator?: IdGenerator;
  clock?: Clock;
  eventPublisher?: EventPublisher;
  metrics?: Metrics;
}

/** Erro inesperado no consumidor: retry curto até o limite de tentativas (ARCHITECTURE 7.3). */
export const UNEXPECTED_ERROR_BACKOFF = { baseMs: 1_000, maxMs: 5_000 };
/** maxReceiveCount do redrive >= 3 x SQS_CONSUMER_MAX_ATTEMPTS (ARCHITECTURE 7.4). */
export const REDRIVE_SAFETY_FACTOR = 3;

// Os use cases não conhecem o Nest: são montados aqui por factory, sem decorators na camada de aplicação.
@Module({})
export class AppModule {
  static forRoot(options: AppOptions = {}): DynamicModule {
    const database = { ...databaseSettingsFromEnv(), ...options.database };
    const sqs = { ...sqsSettingsFromEnv(), ...options.sqs };
    const outbox = { ...outboxSettingsFromEnv(), ...options.outbox };
    validateOutboxSettings(outbox);
    const consumer = { ...consumerSettingsFromEnv(), ...options.consumer };
    if (consumer.enabled) validateConsumerSettings(consumer, database);
    const pending = { ...pendingReferenceSettingsFromEnv(), ...options.pendingReference };
    validatePendingReferenceSettings(pending);
    const ledger = { ...ledgerSettingsFromEnv(), ...options.ledger };
    validateLedgerSettings(ledger);
    validatePoolBudget(database, {
      consumerConcurrency: consumer.enabled ? consumer.concurrency : 0,
      outboxPublishers: outbox.enabled ? 1 : 0,
      pendingReferenceConcurrency: pending.enabled ? pending.concurrency : 0,
    });
    // A mesma política na submissão (primeiro next_attempt_at) e no resolve (os seguintes e o prazo).
    const pendingPolicy: PendingReferencePolicy = {
      ttlMs: pending.ttlMs,
      maxAttempts: pending.maxAttempts,
      backoff: { baseMs: pending.backoffBaseMs, maxMs: pending.backoffMaxMs },
    };
    const useCaseDeps = [UNIT_OF_WORK, ID_GENERATOR, CLOCK];
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmConfig(database.url, { poolMax: database.poolMax }))],
      controllers: [HealthController, WalletsController, WageringTransactionsController, ProviderTransactionsController],
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
        { provide: GetWagerTransaction, useFactory: (uow: UnitOfWork) => new GetWagerTransaction(uow), inject: [UNIT_OF_WORK] },
        {
          provide: WALLET_QUERIES,
          useFactory: (orm: MikroORM) => new SqlWalletQueries(orm),
          inject: [MikroORM],
        },
        { provide: GetWallet, useFactory: (q: WalletQueries) => new GetWallet(q), inject: [WALLET_QUERIES] },
        {
          provide: ReconcileWallet,
          useFactory: (q: WalletQueries, metrics: Metrics) =>
            new ReconcileWallet(q, metrics, new NestStructuredLogger('Reconciliation')),
          inject: [WALLET_QUERIES, METRICS],
        },
        {
          provide: GetLedgerPage,
          useFactory: (q: WalletQueries) => new GetLedgerPage(q, ledger),
          inject: [WALLET_QUERIES],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new CreateWallet(uow, ids, clock),
          inject: useCaseDeps,
        },
        {
          provide: SubmitWagerTransaction,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
            new SubmitWagerTransaction(uow, ids, clock, pendingPolicy),
          inject: useCaseDeps,
        },
        {
          provide: ResolvePendingReference,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
            new ResolvePendingReference(uow, ids, clock, pendingPolicy),
          inject: useCaseDeps,
        },
        {
          provide: PendingReferenceQueries,
          useFactory: (uow: UnitOfWork, clock: Clock) => new PendingReferenceQueries(uow, clock),
          inject: [UNIT_OF_WORK, CLOCK],
        },
        {
          provide: PendingReferenceWorker,
          useFactory: (resolve: ResolvePendingReference, queries: PendingReferenceQueries, metrics: Metrics) =>
            new PendingReferenceWorker(resolve, queries, metrics, new NestStructuredLogger('PendingReferenceWorker'), {
              enabled: pending.enabled,
              batchSize: pending.batchSize,
              concurrency: pending.concurrency,
              pollIntervalMs: pending.pollIntervalMs,
            }),
          inject: [ResolvePendingReference, PendingReferenceQueries, METRICS],
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
        {
          provide: MESSAGE_QUEUE,
          useFactory: () => new SqsMessageQueue(createSqsClient(sqs), consumer.queueUrl, consumer.deadLetterQueueUrl),
        },
        {
          provide: WagerTransactionsConsumer,
          useFactory: (submit: SubmitWagerTransaction, queue: MessageQueue, metrics: Metrics) =>
            new WagerTransactionsConsumer(submit, queue, metrics, new NestStructuredLogger('WagerConsumer'), {
              enabled: consumer.enabled,
              consumerName: CONSUMER_NAME,
              maxAttempts: consumer.maxAttempts,
              waitTimeSeconds: consumer.waitTimeSeconds,
              visibilityTimeoutSeconds: consumer.visibilityTimeoutSeconds,
              concurrency: consumer.concurrency,
              backoff: { baseMs: consumer.backoffBaseMs, maxMs: consumer.backoffMaxMs },
              unexpectedBackoff: UNEXPECTED_ERROR_BACKOFF,
              processingBudgetMs: consumerProcessingBudgetMs(database),
              receiveErrorDelayMs: 1_000,
              redriveSafetyFactor: REDRIVE_SAFETY_FACTOR,
            }),
          inject: [SubmitWagerTransaction, MESSAGE_QUEUE, METRICS],
        },
      ],
    };
  }
}
