import { describe, expect, test } from 'bun:test';
import { describeError, errorFields, MAX_CAUSE_DEPTH, MAX_FRAMES } from '../../../src/infrastructure/logging/describe-error';

/*
 * describeError é uma whitelist (ARCHITECTURE 11.2): o que sai tem formato fechado, e nenhum campo carrega a
 * mensagem, o `detail` do pg ou a query. O valor `123.45` marca o vazamento em todos os testes.
 */

const LEAK = 'balance 123.45 rejected';
const json = (value: unknown): string => JSON.stringify(value);

class NamedLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamedLater'; // atribuído depois do super(): o stack nasce com "Error: ..."
  }
}

describe('describeError', () => {
  test('um erro real lançado no Bun gera ao menos um frame, sem a mensagem', () => {
    let caught: unknown;
    try {
      JSON.parse('{"amount":"123.45"');
    } catch (error) {
      caught = error;
    }
    expect(json(describeError(caught))).not.toContain('123.45');

    let thrown: unknown;
    try {
      throw new Error(LEAK);
    } catch (error) {
      thrown = error;
    }
    const description = describeError(thrown);
    expect(description.frames.length).toBeGreaterThan(0);
    expect(description.frames.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(json(description)).not.toContain('123.45');
  });

  test('nome atribuído depois do super() ainda tem frames', () => {
    const description = describeError(new NamedLater(LEAK));
    expect(description.errorName).toBe('NamedLater');
    expect(description.frames.length).toBeGreaterThan(0);
    expect(json(description)).not.toContain('123.45');
  });

  test('mensagem com frames forjados: o cabeçalho (inclusive as linhas forjadas) é descartado pelo tamanho', () => {
    const forged = new Error('x\n    at 100.00 (a:1:1)\n    at 200.00 (b:2:2)');
    const description = describeError(forged);
    expect(description.frames.length).toBeGreaterThan(0);
    expect(description.frames.join('\n')).not.toContain('100.00');
    expect(description.frames.join('\n')).not.toContain('200.00');
    // Os frames que sobram são os reais: o primeiro aponta para este arquivo, onde o erro foi construído.
    expect(description.frames[0]).toContain('describe-error.test.ts');
    expect(description.frames.some((frame) => frame.includes('a:1:1') || frame.includes('b:2:2'))).toBe(false);
  });

  test('mensagem multilinha que imita o cabeçalho e frames: só frames reais', () => {
    const forged = new Error('first line\nError: second\n    at 100.00 (a:1:1)\nTypeError: third\n    at 300.00 (c:3:3)');
    const { frames } = describeError(forged);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((frame) => /\(.+:\d+:\d+\)$|^at .+:\d+:\d+$/.test(frame))).toBe(true);
    expect(frames.join('\n')).not.toMatch(/100\.00|300\.00|a:1:1|c:3:3/);
    expect(frames[0]).toContain('describe-error.test.ts');
  });

  test('mensagem alterada depois da captura: nunca sai frame forjado (no Bun o cabeçalho acompanha a mensagem)', () => {
    const error = new Error('original');
    error.message = 'mutated 100.00\n    at 100.00 (a:1:1)';
    const { frames } = describeError(error);
    expect(frames.join('\n')).not.toContain('100.00');
    expect(frames.join('\n')).not.toContain('mutated');
  });

  test('stack reescrito à mão com linhas forjadas não confere com o cabeçalho: sem frames', () => {
    const error = new Error('boom');
    error.stack = 'Totally different 100.00\n    at 100.00 (a:1:1)';
    expect(describeError(error).frames).toEqual([]);
  });

  test('limita a quantidade e o tamanho dos frames', () => {
    const error = new Error('deep');
    error.stack = `Error: deep\n${Array.from({ length: 50 }, (_, i) => `    at fn${i} (${'f'.repeat(500)}.ts:1:1)`).join('\n')}`;
    const { frames } = describeError(error);
    expect(frames).toHaveLength(MAX_FRAMES);
    expect(frames.every((frame) => frame.length <= 200)).toBe(true);
  });

  test('erro do pg: SQLSTATE e constraint, nunca detail, query ou parâmetros', () => {
    const pg = Object.assign(new Error(`insert failed ${LEAK}`), {
      code: '23505',
      constraint: 'wt_idempotency_key_uq',
      detail: 'Key (idempotency_key)=(secret-123.45) already exists.',
      query: 'insert into wager_transactions values (123.45)',
      parameters: ['123.45'],
    });
    const description = describeError(pg);
    expect(description.sqlState).toBe('23505');
    expect(description.constraint).toBe('wt_idempotency_key_uq');
    expect(json(description)).not.toContain('123.45');
    expect(json(description)).not.toContain('secret');
    expect(json(description)).not.toContain('insert');
  });

  test('constraint e code só passam se casarem com o formato fechado', () => {
    const weird = Object.assign(new Error('x'), { code: 'balance 123.45', constraint: 'Key (a)=(123.45)' });
    const description = describeError(weird);
    expect(description.code).toBeUndefined();
    expect(description.constraint).toBeUndefined();
    expect(describeError(Object.assign(new Error('x'), { code: 'ECONNRESET' })).code).toBe('ECONNRESET');
    expect(describeError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).code).toBe('ETIMEDOUT');
    // EPIPE tem 5 letras mas nenhum dígito: é um code de socket, não um SQLSTATE.
    const epipe = describeError(Object.assign(new Error('x'), { code: 'EPIPE' }));
    expect(epipe.sqlState).toBeUndefined();
    expect(epipe.code).toBe('EPIPE');
  });

  test('o nome do erro só passa com formato de identificador', () => {
    const error = new Error('x');
    error.name = `Bad name ${LEAK}`;
    expect(describeError(error).errorName).toBe('Error');
  });

  test('cause e AggregateError usam o mesmo filtro, com profundidade limitada', () => {
    const inner = Object.assign(new Error(LEAK), { code: '40P01', detail: LEAK });
    let chain: Error = inner;
    for (let i = 0; i < 10; i++) chain = new Error(`wrap ${i} ${LEAK}`, { cause: chain });
    const description = describeError(chain);
    expect(description.causes.length).toBeLessThanOrEqual(MAX_CAUSE_DEPTH);
    expect(json(description)).not.toContain('123.45');

    const aggregate = new AggregateError(
      Array.from({ length: 20 }, () => Object.assign(new Error(LEAK), { code: 'ECONNREFUSED' })),
      `agg ${LEAK}`,
    );
    const agg = describeError(aggregate);
    expect(agg.causes.length).toBeLessThanOrEqual(5);
    expect(agg.causes.every((c) => c.code === 'ECONNREFUSED')).toBe(true);
    expect(json(agg)).not.toContain('123.45');

    const wrapped = new Error('wrap', { cause: inner });
    expect(describeError(wrapped).sqlState).toBe('40P01'); // o SQLSTATE da causa sobe, como no filtro HTTP
  });

  test('ciclo de causas não trava', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(describeError(a).causes.length).toBeLessThanOrEqual(MAX_CAUSE_DEPTH);
  });

  test('getter que lança não derruba o log', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'code', { get: () => { throw new Error('boom'); } });
    Object.defineProperty(hostile, 'cause', { get: () => { throw new Error('boom'); } });
    expect(() => describeError(hostile)).not.toThrow();
  });

  test('throwable que não é Error não é stringificado', () => {
    expect(describeError(LEAK).errorName).toBe('NonError_string');
    expect(describeError({ toString: () => LEAK, message: LEAK }).errorName).toBe('NonError_object');
    expect(describeError(undefined).errorName).toBe('NonError_undefined');
    expect(describeError(123.45).errorName).toBe('NonError_number');
    for (const value of [LEAK, { message: LEAK }, 123.45, null]) {
      expect(json(describeError(value))).not.toContain('123.45');
      expect(describeError(value).frames).toEqual([]);
    }
  });

  test('errorFields achata a descrição em campos primitivos', () => {
    const fields = errorFields(new Error('x', { cause: Object.assign(new Error('y'), { code: '55P03' }) }));
    expect(fields.errorName).toBe('Error');
    expect(fields.sqlState).toBe('55P03');
    expect(fields.causes).toBe('Error:55P03');
    expect(typeof fields.stack).toBe('string');
  });
});
