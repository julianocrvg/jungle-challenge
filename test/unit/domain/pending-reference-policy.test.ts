import { describe, expect, test } from 'bun:test';
import { backoffDelayMs } from '../../../src/domain/backoff';
import {
  isReferenceWaitExhausted,
  nextReferenceAttemptAt,
  type PendingReferencePolicy,
  referenceWaitDeadline,
} from '../../../src/domain/pending-reference-policy';
import { NOW } from './support';

const policy: PendingReferencePolicy = { ttlMs: 60 * 60_000, maxAttempts: 30, backoff: { baseMs: 1_000, maxMs: 5 * 60_000 } };
const at = (ms: number) => new Date(NOW.getTime() + ms);

/**
 * Simula o cronograma completo como o resolve o percorre: cada tentativa roda exatamente no next_attempt_at
 * agendado e falha (referência ausente) até expirar. Devolve os atrasos usados e quantas tentativas houve.
 */
function walkSchedule(p: PendingReferencePolicy) {
  const createdAt = NOW;
  let next = nextReferenceAttemptAt(createdAt, 0, createdAt, p); // submissão
  const delays = [next.getTime() - createdAt.getTime()];
  const runs: Date[] = [];
  let attempts = 0;
  for (;;) {
    const now = next;
    runs.push(now);
    if (isReferenceWaitExhausted(createdAt, attempts, now, p)) return { delays, runs, attempts, expiredAt: now };
    attempts += 1;
    next = nextReferenceAttemptAt(createdAt, attempts, now, p);
    delays.push(next.getTime() - now.getTime());
  }
}

describe('next_attempt_at schedule', () => {
  test('the submission schedules backoff(1)', () => {
    expect(nextReferenceAttemptAt(NOW, 0, NOW, policy)).toEqual(at(1_000));
  });

  test('every attempt moves exactly one step: backoff(1), backoff(2), ... with no step skipped, until the ceiling', () => {
    const { delays } = walkSchedule(policy);
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000];
    expect(delays.slice(0, expected.length)).toEqual(expected);
    for (let i = 0; i < expected.length; i++) expect(delays[i]).toBe(backoffDelayMs(i + 1, policy.backoff));
  });

  test('is never later than createdAt + ttl, and expires right at the deadline', () => {
    const { runs, attempts, expiredAt } = walkSchedule(policy);
    const deadline = referenceWaitDeadline(NOW, policy);
    for (const run of runs) expect(run.getTime()).toBeLessThanOrEqual(deadline.getTime());
    expect(expiredAt).toEqual(deadline);
    // 1 h com degraus de até 5 min dá ~20 tentativas: o TTL é o limite real, e 30 tentativas é só a rede.
    expect(attempts).toBeGreaterThan(15);
    expect(attempts).toBeLessThan(policy.maxAttempts - 1);
  });

  test('the last step is cut at the deadline instead of a full backoff interval', () => {
    const createdAt = NOW;
    const now = at(policy.ttlMs - 10_000); // faltam 10 s, e o próximo degrau seria de 5 min
    expect(nextReferenceAttemptAt(createdAt, 20, now, policy)).toEqual(referenceWaitDeadline(createdAt, policy));
  });
});

describe('exhaustion', () => {
  test('by TTL: before the deadline it keeps waiting, at the deadline it expires', () => {
    expect(isReferenceWaitExhausted(NOW, 0, at(policy.ttlMs - 1), policy)).toBe(false);
    expect(isReferenceWaitExhausted(NOW, 0, at(policy.ttlMs), policy)).toBe(true);
  });

  test('by attempts, with the TTL still far: the attempt number maxAttempts is the last one', () => {
    const tight = { ...policy, maxAttempts: 3 };
    expect(isReferenceWaitExhausted(NOW, 0, at(1_000), tight)).toBe(false); // 1ª tentativa
    expect(isReferenceWaitExhausted(NOW, 1, at(3_000), tight)).toBe(false); // 2ª
    expect(isReferenceWaitExhausted(NOW, 2, at(7_000), tight)).toBe(true); // 3ª: a última
    const { attempts, expiredAt } = walkSchedule(tight);
    expect(attempts).toBe(2); // duas reagendadas; a terceira expira
    expect(expiredAt.getTime()).toBeLessThan(referenceWaitDeadline(NOW, tight).getTime());
  });
});
