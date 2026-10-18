import { describe, expect, test } from 'bun:test';
import { checkReadiness, type ReadinessProbe } from '../../../src/interface/http/readiness';

const ok = (name: string): ReadinessProbe => ({ name, check: async () => {} });
const failing = (name: string): ReadinessProbe => ({
  name,
  check: async () => {
    throw new TypeError('connect ECONNREFUSED 127.0.0.1:5433 with some free text');
  },
});
/** Ignora o sinal de propósito: o teto tem de valer mesmo assim. */
const hanging = (name: string): ReadinessProbe => ({ name, check: () => new Promise<void>(() => {}) });

describe('checkReadiness', () => {
  test('all probes ok: ready', async () => {
    expect(await checkReadiness([ok('a'), ok('b')])).toEqual({ ready: true, checks: { a: 'ok', b: 'ok' }, failures: {} });
  });

  test('a failing probe: not ready, only the error name is kept (never the message)', async () => {
    const report = await checkReadiness([ok('a'), failing('b')]);
    expect(report).toEqual({ ready: false, checks: { a: 'ok', b: 'down' }, failures: { b: 'TypeError' } });
  });

  test('a probe that never answers and ignores the signal is cut at the timeout; the others are unaffected', async () => {
    let aborted = false;
    const watching: ReadinessProbe = {
      name: 'watching',
      check: (signal) => new Promise<void>(() => signal.addEventListener('abort', () => { aborted = true; })),
    };
    const started = Date.now();
    const report = await checkReadiness([ok('a'), hanging('b'), watching], 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(report).toEqual({
      ready: false,
      checks: { a: 'ok', b: 'down', watching: 'down' },
      failures: { b: 'ReadinessTimeoutError', watching: 'ReadinessTimeoutError' },
    });
    expect(aborted).toBe(true);
  });
});
