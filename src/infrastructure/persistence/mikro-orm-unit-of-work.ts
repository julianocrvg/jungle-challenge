import type { MikroORM } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../application/errors';
import type { TransactionalRepositories, TransactionOptions, UnitOfWork } from '../../application/ports/unit-of-work';
import { isTransientDatabaseError } from './database-errors';
import { sqlRepositories } from './sql-repositories';

/**
 * Cada `run` é uma transação SQL num EntityManager isolado (fork), com conexão própria do pool.
 * `lock_timeout` vale só para esta transação (`SET LOCAL`), ver ARCHITECTURE 5.5.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
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
    try {
      return await (this.orm.em.fork() as EntityManager).transactional(async (em) => {
        await em.execute(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
        if (idleTimeoutMs !== undefined) {
          await em.execute(`SET LOCAL idle_in_transaction_session_timeout = '${idleTimeoutMs}ms'`);
        }
        return work(sqlRepositories(em));
      });
    } catch (error) {
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError('Database temporarily unavailable', { cause: error });
      }
      throw error;
    }
  }
}
