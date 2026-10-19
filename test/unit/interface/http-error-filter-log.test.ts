import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { TransientInfrastructureError } from '../../../src/application/errors';
import { JsonLogger } from '../../../src/infrastructure/logging/json-logger';
import { HttpErrorFilter } from '../../../src/interface/http/http-error.filter';

/*
 * O filtro HTTP é a rede de todos os endpoints (@Catch() global): o que ele loga num 5xx nunca traz a mensagem, o
 * stack textual, o detail do pg nem a query (ARCHITECTURE 11.2). Prova de mutação: trocar o log por `e.message`
 * (ou `e.stack`) quebra estes testes.
 */

const LEAK = 'balance 123.45 for key idem-secret-9';
const lines: string[] = [];

beforeAll(() => {
  Logger.overrideLogger(new JsonLogger((line) => lines.push(line)));
});
afterAll(() => {
  Logger.overrideLogger(true);
});
beforeEach(() => {
  lines.length = 0;
});

interface Captured {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function run(error: unknown): Captured {
  const captured: Captured = { headers: {} };
  const response = {
    status(code: number) { captured.status = code; return response; },
    setHeader(name: string, value: string) { captured.headers[name] = value; },
    json(body: unknown) { captured.body = body; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  new HttpErrorFilter().catch(error, host);
  return captured;
}

describe('HttpErrorFilter: logs de 5xx', () => {
  test('erro inesperado: 500, log só com nome, SQLSTATE, constraint e frames', () => {
    const pg = Object.assign(new Error(`duplicate ${LEAK}`), {
      code: '23505',
      constraint: 'wager_transactions_pkey',
      detail: `Key (id)=(${LEAK}) already exists.`,
      query: `insert into t values (${LEAK})`,
    });
    const result = run(pg);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal error' });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'error', context: 'HttpErrorFilter', responseCode: 'INTERNAL_ERROR', status: 500, sqlState: '23505', constraint: 'wager_transactions_pkey' });
    expect(entry.stack).toContain('at ');
    for (const secret of ['123.45', 'idem-secret', 'duplicate', 'insert into']) expect(lines[0]).not.toContain(secret);
  });

  test('503: mensagem fixa no corpo e no log, Retry-After, SQLSTATE da causa', () => {
    const cause = Object.assign(new Error(`lock timeout ${LEAK}`), { code: '55P03' });
    const result = run(new TransientInfrastructureError(`Database said: ${LEAK}`, { cause }));
    expect(result.status).toBe(503);
    expect(result.headers['Retry-After']).toBe('1');
    expect(result.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable' });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: 'warn', status: 503, sqlState: '55P03' });
    expect(lines[0]).not.toContain('123.45');
    expect(lines[0]).not.toContain('Database said');
  });

  test('throwable que não é Error: 500 sem stringificar', () => {
    const result = run(LEAK);
    expect(result.status).toBe(500);
    expect(lines[0]).not.toContain('123.45');
    expect(JSON.parse(lines[0]!).errorName).toBe('NonError_string');
  });
});
