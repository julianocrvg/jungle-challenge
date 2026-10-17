import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

const command = process.argv[2];
if (command !== 'up' && command !== 'down') {
  console.error('usage: bun scripts/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(createOrmConfig());
try {
  // down sem argumentos reverte apenas a última migration aplicada.
  const result = command === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  console.log(JSON.stringify({ command, migrations: result.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
