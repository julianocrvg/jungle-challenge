import { describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/core';
import { TransientInfrastructureError } from '../../../src/application/errors';
import { InMemoryMetrics } from '../../../src/infrastructure/metrics/in-memory-metrics';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';

/*
 * A classificação de db_lock_conflicts_total acontece num único ponto, o UnitOfWork (ARCHITECTURE 11.4). O 55P03
 * real (lock_timeout) está em metrics-http.test.ts, contra o Postgres. Aqui, só a classificação do que o driver
 * lança, com um `transactional` que falha com o SQLSTATE pedido: um deadlock (40P01) não se provoca de forma
 * determinística no Postgres real, porque a vítima é escolhida por ele.
 */

function uowThatFailsWith(error: unknown, metrics: InMemoryMetrics): MikroOrmUnitOfWork {
  const orm = { em: { fork: () => ({ transactional: async () => { throw error; } }) } } as unknown as MikroORM;
  return new MikroOrmUnitOfWork(orm, 1_000, metrics);
}

const pgError = (code: string): Error => Object.assign(new Error('driver text 123.45'), { code });

describe('db_lock_conflicts_total', () => {
  test.each([['55P03'], ['40P01']])('%s conta uma vez, com o SQLSTATE como label, e vira TransientInfrastructureError', async (state) => {
    const metrics = new InMemoryMetrics();
    const error = await uowThatFailsWith(pgError(state), metrics).run(async () => 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect(metrics.counter('db_lock_conflicts_total', { sqlstate: state })).toBe(1);
    expect(Object.keys(metrics.counterSnapshot())).toEqual([`db_lock_conflicts_total{sqlstate="${state}"}`]);
  });

  test('um erro transitório que não é de lock (conexão, serialização) não conta', async () => {
    const metrics = new InMemoryMetrics();
    for (const code of ['40001', '57P01', '08006', 'ECONNREFUSED']) {
      await uowThatFailsWith(pgError(code), metrics).run(async () => 1).catch(() => undefined);
    }
    expect(metrics.counterSnapshot()).toEqual({});
  });

  test('um erro que não é do banco passa sem contar', async () => {
    const metrics = new InMemoryMetrics();
    await expect(uowThatFailsWith(new Error('bug'), metrics).run(async () => 1)).rejects.toThrow('bug');
    expect(metrics.counterSnapshot()).toEqual({});
  });
});
