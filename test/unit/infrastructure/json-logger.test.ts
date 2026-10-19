import { describe, expect, test } from 'bun:test';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';

function capture(): { logger: JsonLogger; lines: string[] } {
  const lines: string[] = [];
  return { logger: new JsonLogger((line) => lines.push(line)), lines };
}

describe('JsonLogger', () => {
  test('uma linha JSON por entrada, com level, timestamp, context e message', () => {
    const { logger, lines } = capture();
    logger.log({ message: 'processed', transactionId: 't1', walletId: 'w1' }, 'WagerConsumer');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'info', context: 'WagerConsumer', message: 'processed', transactionId: 't1', walletId: 'w1' });
    expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    expect(lines[0]).not.toContain('\n');
  });

  test('o stack que o Nest passa em error(message, stack, context) é descartado', () => {
    const { logger, lines } = capture();
    const stack = 'Error: balance 123.45\n    at fn (file.ts:1:1)';
    logger.error('failed', stack, 'Ctx');
    expect(lines[0]).not.toContain('123.45');
    expect(lines[0]).not.toContain('at fn');
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'error', context: 'Ctx', message: 'failed' });
  });

  test('um stack como único parâmetro nunca sai como context', () => {
    const { logger, lines } = capture();
    logger.error('failed', 'Error: x\n    at fn (file.ts:1:1)');
    logger.error('failed', 'free text with spaces 123.45');
    logger.error('failed', 'Error: single-line-stack-with-colon');
    for (const line of lines) {
      expect(JSON.parse(line).context).toBeUndefined();
      expect(line).not.toContain('123.45');
    }
  });

  test('um Error como mensagem sai por errorFields, sem a mensagem nem o stack textual', () => {
    const { logger, lines } = capture();
    logger.error(Object.assign(new Error('insert 123.45 failed'), { code: '23505', constraint: 'wt_idempotency_key_uq' }));
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ message: 'error', sqlState: '23505', constraint: 'wt_idempotency_key_uq' });
    expect(lines[0]).not.toContain('123.45');
  });

  test('os campos reservados não são sobrescritos pelos campos do log', () => {
    const { logger, lines } = capture();
    logger.log({ message: 'real', level: 'fake', timestamp: 'fake', context: 'fake' }, 'Real');
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', message: 'real', context: 'Real' });
    expect(JSON.parse(lines[0]!).timestamp).not.toBe('fake');
  });

  test('valores não serializáveis não derrubam o logger', () => {
    const { logger, lines } = capture();
    const cyclic: Record<string, unknown> = { message: 'cyc' };
    cyclic.self = cyclic;
    logger.log(cyclic);
    logger.log({ message: 'big', value: 10n });
    expect(JSON.parse(lines[0]!).message).toBe('log entry not serializable');
    expect(JSON.parse(lines[1]!).value).toBe('10');
  });
});
