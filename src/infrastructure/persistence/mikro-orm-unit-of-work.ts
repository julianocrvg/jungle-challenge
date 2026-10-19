import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors';
import { type Metrics, NOOP_METRICS } from '../../application/ports/metrics';
import type { TransactionalRepositories, TransactionOptions, UnitOfWork } from '../../application/ports/unit-of-work';
import { isTransientDatabaseError, sqlStateOf } from './database-errors';
import { sqlRepositories } from './sql-repositories';

const LOCK_TIMEOUT = '55P03';
const DEADLOCK = '40P01';

/**
 * Cada `run` é uma transação SQL num EntityManager isolado (fork), com conexão própria do pool.
 * `lock_timeout` vale só para esta transação (`SET LOCAL`), ver ARCHITECTURE 5.5.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {
    // SET não aceita parâmetro ligado; o valor é interpolado, então só um inteiro positivo é aceito.
    if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0) {
      throw new Error('lockTimeoutMs must be a positive integer');
    }
  }

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const idleTimeoutMs = options.idleInTransactionTimeoutMs;
    if (idleTimeoutMs !== undefined && (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs <= 0)) {
      throw new Error('idleInTransactionTimeoutMs must be a positive integer');
    }
    const statementTimeoutMs = options.statementTimeoutMs;
    if (statementTimeoutMs !== undefined && (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0)) {
      throw new Error('statementTimeoutMs must be a positive integer');
    }
    try {
      return await (this.orm.em.fork() as EntityManager).transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
        if (idleTimeoutMs !== undefined) {
          await em.execute(`SET LOCAL idle_in_transaction_session_timeout = '${idleTimeoutMs}ms'`);
        }
        if (statementTimeoutMs !== undefined) {
          await em.execute(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
        }
        return work(sqlRepositories(em));
      });
    } catch (error) {
      // O único ponto onde o erro do banco é classificado: um conflito de lock conta UMA vez, aqui. HTTP, consumidor e
      // workers só veem o TransientInfrastructureError já embrulhado (não contam de novo).
      const state = sqlStateOf(error);
      if (state === LOCK_TIMEOUT || state === DEADLOCK) this.metrics.increment('db_lock_conflicts_total', { sqlstate: state });
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError('Database temporarily unavailable', { cause: error });
      }
      throw error;
    }
  }
}
