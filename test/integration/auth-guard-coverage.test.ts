import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { AuthGuard } from '../../src/interface/http/auth.guard';
import { startTestApp, type TestApp } from './support/app';

/*
 * Todo controller de negócio precisa do AuthGuard (ARCHITECTURE 11.1). Os controllers são descobertos no
 * container do Nest, não listados à mão: um controller novo sem guard quebra este teste.
 * Só a allowlist explícita abaixo fica aberta (CLAUDE.md, "Autenticação").
 */
const OPEN_CONTROLLERS = new Set(['HealthController', 'MetricsController']);

let api: TestApp;

beforeAll(async () => {
  api = await startTestApp();
});

afterAll(async () => {
  await api?.close();
});

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
}

test('todo controller fora da allowlist usa o AuthGuard no nível da classe', () => {
  const controllers = [...api.app.get(ModulesContainer, { strict: false }).values()]
    .flatMap((module) => [...module.controllers.values()])
    .map((wrapper) => wrapper.metatype)
    .filter((metatype): metatype is NonNullable<typeof metatype> => metatype !== null && metatype !== undefined);
  const names = controllers.map((c) => c.name);

  // Sanidade da descoberta: sem isso, um container vazio passaria o teste.
  expect(names).toContain('HealthController');
  expect(names).toContain('WalletsController');
  expect(names).toContain('WageringTransactionsController');
  expect(controllers.length).toBeGreaterThanOrEqual(4);

  const unguarded = controllers.filter((c) => !OPEN_CONTROLLERS.has(c.name) && !guardsOf(c).includes(AuthGuard));
  expect(unguarded.map((c) => c.name)).toEqual([]);
});

test('o AuthGuard cobre POST /wallets e POST /wagering/transactions', () => {
  const guarded = new Map<string, unknown[]>();
  for (const module of api.app.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of module.controllers.values()) {
      if (wrapper.metatype) guarded.set(wrapper.metatype.name, guardsOf(wrapper.metatype));
    }
  }
  expect(guarded.get('WalletsController')).toContain(AuthGuard);
  expect(guarded.get('WageringTransactionsController')).toContain(AuthGuard);
});
