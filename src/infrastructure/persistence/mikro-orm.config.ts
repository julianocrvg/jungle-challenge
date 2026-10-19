import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { DEFAULT_POOL_MAX, databaseSettingsFromEnv } from '../../config';
import { migrations } from './migrations';
import { releaseClientsBrokenByServer } from './pool-guard';

export function databaseUrl(): string {
  return databaseSettingsFromEnv().url;
}

export function createOrmConfig(clientUrl: string = databaseUrl(), options: { poolMax?: number } = {}) {
  return defineConfig({
    clientUrl,
    // Sem entidades: os comandos usam SQL explícito (ARCHITECTURE 1.2), assim como as leituras (ARCHITECTURE 1.2).
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: options.poolMax ?? DEFAULT_POOL_MAX },
    // Conexão derrubada pelo servidor no meio de uma transação não pode vazar a vaga do pool (pool-guard.ts).
    driverOptions: { onPoolCreated: releaseClientsBrokenByServer },
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: migrations,
      transactional: true,
      allOrNothing: true,
      // Sem snapshot de schema: as migrations são escritas à mão, não geradas por diff.
      snapshot: false,
    },
  });
}
