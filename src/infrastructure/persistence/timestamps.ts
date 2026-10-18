const PG_TIMESTAMPTZ = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-]\d{2})(?::?(\d{2}))?$/;

/**
 * O MikroORM registra no driver um parser que devolve `timestamptz` como texto (`2026-10-17 12:00:00.123456+00`),
 * e as consultas cruas dos repositórios recebem esse texto. Aqui ele vira `Date` de forma explícita: o formato do
 * Postgres não é ISO 8601 (espaço no lugar de `T`, offset `+00`), e `new Date` não o aceita em todo runtime.
 * A precisão cai de microssegundos para milissegundos, a mesma de um `Date` gravado pela aplicação.
 */
export function parseTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  const match = typeof value === 'string' ? PG_TIMESTAMPTZ.exec(value) : null;
  if (match === null) throw new Error(`Unexpected timestamptz value: ${String(value)}`);
  const [, day, time, fraction = '', offsetHours, offsetMinutes = '00'] = match;
  const millis = fraction.padEnd(3, '0').slice(0, 3);
  const parsed = new Date(`${day}T${time}.${millis}${offsetHours}:${offsetMinutes}`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamptz value: ${value}`);
  return parsed;
}

export function parseOptionalTimestamp(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : parseTimestamp(value);
}
