import { describe, expect, test } from 'bun:test';
import { parseOptionalTimestamp, parseTimestamp } from '../../../src/infrastructure/persistence/timestamps';

describe('parseTimestamp (texto timestamptz do Postgres)', () => {
  test('UTC sem fração', () => {
    expect(parseTimestamp('2020-01-01 00:00:00+00').toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  test('microssegundos são truncados para milissegundos', () => {
    expect(parseTimestamp('2026-10-18 20:35:41.564187+00').toISOString()).toBe('2026-10-18T20:35:41.564Z');
    expect(parseTimestamp('2026-10-18 20:35:41.5+00').toISOString()).toBe('2026-10-18T20:35:41.500Z');
  });

  test('offset com minutos', () => {
    expect(parseTimestamp('2026-10-18 12:00:00-03').toISOString()).toBe('2026-10-18T15:00:00.000Z');
    expect(parseTimestamp('2026-10-18 12:00:00+05:30').toISOString()).toBe('2026-10-18T06:30:00.000Z');
  });

  test('Date passa direto; formato inesperado lança', () => {
    const now = new Date();
    expect(parseTimestamp(now)).toBe(now);
    expect(() => parseTimestamp('ontem')).toThrow(/Unexpected timestamptz/);
    expect(() => parseTimestamp(123)).toThrow(/Unexpected timestamptz/);
  });

  test('opcional: null vira undefined', () => {
    expect(parseOptionalTimestamp(null)).toBeUndefined();
    expect(parseOptionalTimestamp(undefined)).toBeUndefined();
  });
});
