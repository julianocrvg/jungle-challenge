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

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,8}$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}
