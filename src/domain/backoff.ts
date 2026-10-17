export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 5 * 60_000 };

/**
 * Backoff exponencial com teto: baseMs * 2^(attempt-1), limitado a maxMs. `attempt` começa em 1.
 * Sem jitter de propósito: o domínio fica determinístico e testável. Jitter, se necessário, é da infraestrutura.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(policy.baseMs * 2 ** exponent, policy.maxMs);
}
