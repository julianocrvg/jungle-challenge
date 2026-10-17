import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { DEFAULT_POOL_MAX, databaseSettingsFromEnv } from '../../config';
import { migrations } from './migrations';

export function databaseUrl(): string {
  return databaseSettingsFromEnv().url;
}

export function createOrmConfig(clientUrl: string = databaseUrl(), options: { poolMax?: number } = {}) {
  return defineConfig({
    clientUrl,
    // Sem entidades: os comandos usam SQL explícito (ARCHITECTURE 1.2), e as leituras entram na fatia 5.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: options.poolMax ?? DEFAULT_POOL_MAX },
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
