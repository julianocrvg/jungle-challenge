/**
 * Classificação de erros do Postgres. O MikroORM embrulha o erro do driver em DriverException, mas preserva
 * `code` (SQLSTATE) e `constraint`; olhamos também `cause` para cobrir o erro cru do `pg`.
 */
interface PgLikeError {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  cause?: { code?: unknown; constraint?: unknown };
}

export const UNIQUE_VIOLATION = '23505';

export function sqlStateOf(error: unknown): string | undefined {
  const e = error as PgLikeError | undefined;
  for (const candidate of [e?.code, e?.sqlState, e?.cause?.code]) {
    if (typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
  }
  return undefined;
}

export function constraintOf(error: unknown): string | undefined {
  const e = error as PgLikeError | undefined;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/** O nome da constraint violada, se o erro for 23505. */
export function uniqueViolationConstraint(error: unknown): string | undefined {
  return sqlStateOf(error) === UNIQUE_VIOLATION ? constraintOf(error) : undefined;
}

// Situações em que repetir a mesma requisição mais tarde pode dar certo.
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND']);

export function isTransientDatabaseError(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state !== undefined) return TRANSIENT_SQLSTATES.has(state) || state.startsWith('08'); // 08: connection_exception
  const e = error as PgLikeError | undefined;
  return [e?.code, e?.cause?.code].some((code) => typeof code === 'string' && TRANSIENT_NODE_CODES.has(code));
}
