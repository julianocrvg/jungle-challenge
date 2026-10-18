import { type BackoffPolicy, backoffDelayMs, DEFAULT_BACKOFF } from './backoff';

/**
 * Limites da espera por referência (ARCHITECTURE 8.3). `ttlMs` conta a partir de `createdAt` e é o limite de
 * negócio; `maxAttempts` é a rede de segurança para um backoff configurado pequeno demais.
 */
export interface PendingReferencePolicy {
  ttlMs: number;
  maxAttempts: number;
  backoff: BackoffPolicy;
}

export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  ttlMs: 60 * 60_000,
  maxAttempts: 30,
  backoff: DEFAULT_BACKOFF,
};

/** Instante em que a espera termina: `createdAt + ttl`. */
export function referenceWaitDeadline(createdAt: Date, policy: PendingReferencePolicy): Date {
  return new Date(createdAt.getTime() + policy.ttlMs);
}

/**
 * Cronograma de `next_attempt_at`. `attemptsDone` é o valor de `attempts` DEPOIS de contar a tentativa que
 * acabou de falhar (0 na submissão), e a próxima espera é `backoff(attemptsDone + 1)`: submissão → backoff(1),
 * 1ª tentativa → backoff(2), sem pular degrau. Nunca passa do prazo, para a expiração não atrasar até um
 * intervalo inteiro de backoff.
 */
export function nextReferenceAttemptAt(
  createdAt: Date, attemptsDone: number, now: Date, policy: PendingReferencePolicy,
): Date {
  const scheduled = now.getTime() + backoffDelayMs(attemptsDone + 1, policy.backoff);
  return new Date(Math.min(scheduled, referenceWaitDeadline(createdAt, policy).getTime()));
}

/**
 * A tentativa em curso (a de número `attemptsBefore + 1`) é a última? Sim se o prazo chegou ou se ela atinge
 * `maxAttempts`. Quem chama só expira depois de tentar resolver: uma referência que chegou no fim do prazo
 * ainda é aplicada.
 */
export function isReferenceWaitExhausted(
  createdAt: Date, attemptsBefore: number, now: Date, policy: PendingReferencePolicy,
): boolean {
  return now.getTime() >= referenceWaitDeadline(createdAt, policy).getTime() || attemptsBefore + 1 >= policy.maxAttempts;
}
