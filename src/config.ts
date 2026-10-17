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

function positiveInteger(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d{0,8}$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}
