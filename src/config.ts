import { hostname } from 'node:os';

/** Configuração lida do ambiente. Só inteiros de infraestrutura: nenhum valor monetário passa por aqui. */
export interface DatabaseSettings {
  url: string;
  /** Conexões do pool. Pelo menos 20 por padrão (ARCHITECTURE 5.5). */
  poolMax: number;
  /** `SET LOCAL lock_timeout` de cada transação de escrita, em ms (ARCHITECTURE 5.5). */
  lockTimeoutMs: number;
}

export const DEFAULT_DATABASE_URL = 'postgres://wagering:wagering@localhost:5433/wagering';
export const DEFAULT_POOL_MAX = 20;
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export function databaseSettingsFromEnv(env: Record<string, string | undefined> = process.env): DatabaseSettings {
  return {
    url: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    poolMax: positiveInteger(env, 'DB_POOL_MAX', DEFAULT_POOL_MAX),
    lockTimeoutMs: positiveInteger(env, 'DB_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS),
  };
}

export interface SqsSettings {
  endpoint: string;
  region: string;
  /** Fila FIFO de saída dos eventos de integração (ARCHITECTURE 6.1). */
  eventsQueueUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const DEFAULT_SQS_ENDPOINT = 'http://localhost:4566';

export function sqsSettingsFromEnv(env: Record<string, string | undefined> = process.env): SqsSettings {
  const endpoint = env.SQS_ENDPOINT ?? DEFAULT_SQS_ENDPOINT;
  return {
    endpoint,
    region: env.AWS_REGION ?? 'us-east-1',
    eventsQueueUrl: env.SQS_EVENTS_QUEUE_URL ?? `${endpoint}/000000000000/wager-events.fifo`,
    // Credenciais fictícias aceitas pelo LocalStack. Em AWS real, vêm do ambiente.
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
  };
}

export interface OutboxSettings {
  /** Liga o laço do publisher nesta instância. */
  enabled: boolean;
  /** Mensagens por lote: no máximo 10, o limite do SendMessageBatch. */
  batchSize: number;
  /** Espera entre ticks quando o lote veio incompleto (não há mais nada vencido). */
  pollIntervalMs: number;
  /** Teto da chamada ao SQS. A transação do lote fica aberta durante a chamada (ARCHITECTURE 6.2). */
  sendTimeoutMs: number;
  /** `SET LOCAL idle_in_transaction_session_timeout` do lote: rede de proteção se o processo travar. */
  idleInTransactionTimeoutMs: number;
}

export const DEFAULT_OUTBOX_BATCH_SIZE = 10;
export const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 500;
export const DEFAULT_OUTBOX_SEND_TIMEOUT_MS = 5_000;
export const MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000;

/** Default do idle timeout: 3x o timeout de envio, nunca abaixo de 15 s (ARCHITECTURE 6.2). */
export function defaultIdleInTransactionTimeoutMs(sendTimeoutMs: number): number {
  return Math.max(3 * sendTimeoutMs, MIN_IDLE_IN_TRANSACTION_TIMEOUT_MS);
}

export function outboxSettingsFromEnv(env: Record<string, string | undefined> = process.env): OutboxSettings {
  const sendTimeoutMs = positiveInteger(env, 'OUTBOX_SEND_TIMEOUT_MS', DEFAULT_OUTBOX_SEND_TIMEOUT_MS);
  const settings: OutboxSettings = {
    enabled: env.OUTBOX_PUBLISHER_ENABLED !== 'false',
    batchSize: positiveInteger(env, 'OUTBOX_BATCH_SIZE', DEFAULT_OUTBOX_BATCH_SIZE),
    pollIntervalMs: positiveInteger(env, 'OUTBOX_POLL_INTERVAL_MS', DEFAULT_OUTBOX_POLL_INTERVAL_MS),
    sendTimeoutMs,
    idleInTransactionTimeoutMs: positiveInteger(
      env, 'OUTBOX_IDLE_TX_TIMEOUT_MS', defaultIdleInTransactionTimeoutMs(sendTimeoutMs),
    ),
  };
  validateOutboxSettings(settings);
  return settings;
}

/**
 * Durante a chamada ao SQS a sessão fica ociosa dentro da transação. Se o idle timeout não for bem maior
 * que o timeout de envio, um envio lento mas válido derrubaria a sessão (ARCHITECTURE 6.2).
 */
export function validateOutboxSettings(settings: OutboxSettings): void {
  if (settings.batchSize > 10) {
    throw new Error(`OUTBOX_BATCH_SIZE must be at most 10 (SendMessageBatch limit), got ${settings.batchSize}`);
  }
  if (settings.idleInTransactionTimeoutMs < defaultIdleInTransactionTimeoutMs(settings.sendTimeoutMs)) {
    throw new Error(
      'OUTBOX_IDLE_TX_TIMEOUT_MS must be at least max(3 x OUTBOX_SEND_TIMEOUT_MS, 15000), '
      + `got ${settings.idleInTransactionTimeoutMs} for a send timeout of ${settings.sendTimeoutMs}`,
    );
  }
}

export interface ConsumerSettings {
  /** Liga o consumidor de wager-transactions.fifo nesta instância. */
  enabled: boolean;
  queueUrl: string;
  deadLetterQueueUrl: string;
  /** Tentativas (receives) antes da DLQ para falhas transitórias (ARCHITECTURE 7.4). */
  maxAttempts: number;
  /** Long polling: até 20 s, o limite do SQS. */
  waitTimeSeconds: number;
  /** Visibilidade pedida no ReceiveMessage. Precisa cobrir lock_timeout + margem (validado). */
  visibilityTimeoutSeconds: number;
  /** Mensagens processadas em paralelo por instância, cada uma com uma conexão: abaixo do pool (validado). */
  concurrency: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const CONSUMER_NAME = 'wager-transactions';
export const DEFAULT_CONSUMER_MAX_ATTEMPTS = 5;
export const DEFAULT_CONSUMER_WAIT_SECONDS = 20;
export const DEFAULT_CONSUMER_VISIBILITY_TIMEOUT_S = 30;
export const DEFAULT_CONSUMER_CONCURRENCY = 10;
/** Margem de processamento além do lock_timeout: SQL da submissão, commit e ack. */
export const CONSUMER_PROCESSING_MARGIN_MS = 5_000;
/** Teto do ChangeMessageVisibility no SQS: 12 h. */
const MAX_VISIBILITY_MS = 12 * 60 * 60 * 1000;

export function consumerSettingsFromEnv(env: Record<string, string | undefined> = process.env): ConsumerSettings {
  const endpoint = env.SQS_ENDPOINT ?? DEFAULT_SQS_ENDPOINT;
  return {
    enabled: env.SQS_CONSUMER_ENABLED !== 'false',
    queueUrl: env.SQS_TRANSACTIONS_QUEUE_URL ?? `${endpoint}/000000000000/wager-transactions.fifo`,
    deadLetterQueueUrl: env.SQS_TRANSACTIONS_DLQ_URL ?? `${endpoint}/000000000000/wager-transactions-dlq.fifo`,
    maxAttempts: positiveInteger(env, 'SQS_CONSUMER_MAX_ATTEMPTS', DEFAULT_CONSUMER_MAX_ATTEMPTS),
    waitTimeSeconds: positiveInteger(env, 'SQS_CONSUMER_WAIT_SECONDS', DEFAULT_CONSUMER_WAIT_SECONDS),
    visibilityTimeoutSeconds: positiveInteger(env, 'SQS_CONSUMER_VISIBILITY_TIMEOUT_S', DEFAULT_CONSUMER_VISIBILITY_TIMEOUT_S),
    concurrency: positiveInteger(env, 'SQS_CONSUMER_CONCURRENCY', DEFAULT_CONSUMER_CONCURRENCY),
    backoffBaseMs: positiveInteger(env, 'SQS_CONSUMER_BACKOFF_BASE_MS', 1_000),
    backoffMaxMs: positiveInteger(env, 'SQS_CONSUMER_BACKOFF_MAX_MS', 60_000),
  };
}

/** Tempo que uma mensagem pode levar: o maior lock_timeout possível mais a margem (ARCHITECTURE 7.4). */
export function consumerProcessingBudgetMs(database: Pick<DatabaseSettings, 'lockTimeoutMs'>): number {
  return database.lockTimeoutMs + CONSUMER_PROCESSING_MARGIN_MS;
}

/**
 * Visibilidade menor que lock_timeout + margem: a mensagem reapareceria para outro consumidor enquanto a
 * primeira ainda espera o lock, gerando trabalho duplicado (a inbox deduplica, mas é desperdício e contenção).
 * A concorrência é conferida junto com os outros workers em `validatePoolBudget`.
 */
export function validateConsumerSettings(
  settings: ConsumerSettings, database: Pick<DatabaseSettings, 'lockTimeoutMs'>,
): void {
  if (settings.waitTimeSeconds > 20) {
    throw new Error(`SQS_CONSUMER_WAIT_SECONDS must be at most 20, got ${settings.waitTimeSeconds}`);
  }
  if (settings.visibilityTimeoutSeconds * 1000 < consumerProcessingBudgetMs(database)) {
    throw new Error(
      `SQS_CONSUMER_VISIBILITY_TIMEOUT_S must cover DB_LOCK_TIMEOUT_MS + ${CONSUMER_PROCESSING_MARGIN_MS} ms, `
      + `got ${settings.visibilityTimeoutSeconds} s for a lock timeout of ${database.lockTimeoutMs} ms`,
    );
  }
  if (settings.backoffMaxMs > MAX_VISIBILITY_MS || settings.backoffBaseMs > settings.backoffMaxMs) {
    throw new Error('SQS_CONSUMER_BACKOFF_BASE_MS <= SQS_CONSUMER_BACKOFF_MAX_MS <= 12 h is required');
  }
}

export interface PendingReferenceSettings {
  /** Liga o worker de PENDING_REFERENCE nesta instância. */
  enabled: boolean;
  /** Espera entre ciclos quando o lote veio incompleto ou algum item falhou. */
  pollIntervalMs: number;
  /** Pendentes vencidas listadas por ciclo. */
  batchSize: number;
  /** Resolves em paralelo, cada um com uma conexão: entra no orçamento do pool (validado). */
  concurrency: number;
  /** Prazo da espera a partir de `created_at` (ARCHITECTURE 8.3). */
  ttlMs: number;
  /** Rede de segurança: tentativas de resolução antes de expirar. */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_PENDING_REFERENCE_SETTINGS: Omit<PendingReferenceSettings, 'enabled'> = {
  pollIntervalMs: 1_000,
  batchSize: 50,
  concurrency: 4,
  ttlMs: 60 * 60_000,
  maxAttempts: 30,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60_000,
};

export function pendingReferenceSettingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PendingReferenceSettings {
  const d = DEFAULT_PENDING_REFERENCE_SETTINGS;
  return {
    enabled: env.PENDING_REFERENCE_WORKER_ENABLED !== 'false',
    pollIntervalMs: positiveInteger(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', d.pollIntervalMs),
    batchSize: positiveInteger(env, 'PENDING_REFERENCE_BATCH_SIZE', d.batchSize),
    concurrency: positiveInteger(env, 'PENDING_REFERENCE_CONCURRENCY', d.concurrency),
    ttlMs: positiveInteger(env, 'PENDING_REFERENCE_TTL_MS', d.ttlMs),
    maxAttempts: positiveInteger(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', d.maxAttempts),
    backoffBaseMs: positiveInteger(env, 'PENDING_REFERENCE_BACKOFF_BASE_MS', d.backoffBaseMs),
    backoffMaxMs: positiveInteger(env, 'PENDING_REFERENCE_BACKOFF_MAX_MS', d.backoffMaxMs),
  };
}

export function validatePendingReferenceSettings(settings: PendingReferenceSettings): void {
  if (settings.backoffBaseMs > settings.backoffMaxMs) {
    throw new Error('PENDING_REFERENCE_BACKOFF_BASE_MS must not exceed PENDING_REFERENCE_BACKOFF_MAX_MS');
  }
}

/** Conexões que os workers nunca podem ocupar: ficam para o HTTP e o health check (ARCHITECTURE 8.5). */
export const HTTP_RESERVED_CONNECTIONS = 5;

/**
 * Cada unidade de trabalho de um worker segura uma conexão do pool: mensagem do consumidor, lote do publisher,
 * resolve de pendente. Somados, ficam em no máximo DB_POOL_MAX - 5, para que um pico nos workers nunca deixe
 * o HTTP sem conexão. Com os defaults: 10 + 1 + 4 = 15 = 20 - 5.
 */
export function validatePoolBudget(
  database: Pick<DatabaseSettings, 'poolMax'>,
  workers: { consumerConcurrency: number; outboxPublishers: number; pendingReferenceConcurrency: number },
): void {
  const used = workers.consumerConcurrency + workers.outboxPublishers + workers.pendingReferenceConcurrency;
  const available = database.poolMax - HTTP_RESERVED_CONNECTIONS;
  if (used > available) {
    throw new Error(
      `Workers need ${used} connections (SQS_CONSUMER_CONCURRENCY ${workers.consumerConcurrency} + outbox publisher `
      + `${workers.outboxPublishers} + PENDING_REFERENCE_CONCURRENCY ${workers.pendingReferenceConcurrency}), `
      + `but at most DB_POOL_MAX (${database.poolMax}) - ${HTTP_RESERVED_CONNECTIONS} reserved for HTTP = ${available} are allowed`,
    );
  }
}

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,8}$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

/**
 * Identidade desta instância nos logs e no header `X-Instance-Id` (ARCHITECTURE 10.2). Default: host e pid, que
 * já distinguem processos na mesma máquina. Texto de diagnóstico, nunca usado para decidir nada.
 */
export function instanceIdFromEnv(env: Record<string, string | undefined> = process.env): string {
  const raw = env.INSTANCE_ID;
  if (raw === undefined || raw === '') return `${hostname()}-${process.pid}`;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw)) {
    throw new Error(`INSTANCE_ID must be 1 to 64 characters of [A-Za-z0-9._-], got "${raw}"`);
  }
  return raw;
}

/** Paginação do ledger (ARCHITECTURE 9.2). */
export interface LedgerSettings {
  defaultPageSize: number;
  maxPageSize: number;
}

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const DEFAULT_LEDGER_MAX_PAGE_SIZE = 100;

export function ledgerSettingsFromEnv(env: Record<string, string | undefined> = process.env): LedgerSettings {
  return {
    defaultPageSize: positiveInteger(env, 'LEDGER_DEFAULT_PAGE_SIZE', DEFAULT_LEDGER_PAGE_SIZE),
    maxPageSize: positiveInteger(env, 'LEDGER_MAX_PAGE_SIZE', DEFAULT_LEDGER_MAX_PAGE_SIZE),
  };
}

export function validateLedgerSettings(settings: LedgerSettings): void {
  if (settings.defaultPageSize > settings.maxPageSize) {
    throw new Error('LEDGER_DEFAULT_PAGE_SIZE must not exceed LEDGER_MAX_PAGE_SIZE');
  }
}
