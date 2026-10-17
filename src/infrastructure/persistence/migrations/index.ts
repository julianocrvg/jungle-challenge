import type { MigrationObject } from '@mikro-orm/core';
import { Migration20261017000001_initial_schema } from './Migration20261017000001_initial_schema';
import { Migration20261017000002_single_reversal_and_reference_not_processed } from './Migration20261017000002_single_reversal_and_reference_not_processed';
import { Migration20261017000003_player_mismatch_and_internal_provider } from './Migration20261017000003_player_mismatch_and_internal_provider';

// Lista explícita em vez de descoberta por glob: ordem determinística e sem depender de ts-node.
export const migrations: MigrationObject[] = [
  { name: 'Migration20261017000001_initial_schema', class: Migration20261017000001_initial_schema },
  {
    name: 'Migration20261017000002_single_reversal_and_reference_not_processed',
    class: Migration20261017000002_single_reversal_and_reference_not_processed,
  },
  {
    name: 'Migration20261017000003_player_mismatch_and_internal_provider',
    class: Migration20261017000003_player_mismatch_and_internal_provider,
  },
];
