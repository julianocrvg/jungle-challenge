import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrations } from './migrations';

export const DEFAULT_DATABASE_URL = 'postgres://wagering:wagering@localhost:5433/wagering';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function createOrmConfig(clientUrl: string = databaseUrl()) {
  return defineConfig({
    clientUrl,
    // Entidades de persistência (EntitySchema) entram a partir da fatia 3.
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
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
