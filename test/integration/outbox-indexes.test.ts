import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { CLAIM_DUE_SQL, OLDEST_PENDING_SQL } from '../../src/infrastructure/persistence/sql-repositories';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';

/*
 * Índices parciais da outbox (ARCHITECTURE 6.8, migration 0004) provados com EXPLAIN das consultas REAIS
 * (CLAIM_DUE_SQL e OLDEST_PENDING_SQL, as mesmas que o repositório executa) sobre volume realista: 50 mil linhas
 * publicadas e 5 mil pendentes, seguido de ANALYZE. Com poucas linhas o planner prefere Seq Scan e o teste não
 * provaria nada.
 */

const PREVIOUS_MIGRATION = 'Migration20261017000003_player_mismatch_and_internal_provider';
const PUBLISHED = 50_000;
const PENDING = 5_000;

let orm: MikroORM;
let sql: Sql;

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
});

afterEach(async () => {
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
});

afterAll(async () => {
  await orm?.close(true);
});

interface PlanNode { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] }

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

async function explain(query: string, params: unknown[] = []): Promise<PlanNode[]> {
  const [row] = await sql(`EXPLAIN (FORMAT JSON) ${query}`, params);
  const json = row?.['QUERY PLAN'];
  const parsed = (typeof json === 'string' ? JSON.parse(json) : json) as [{ Plan: PlanNode }];
  return nodes(parsed[0].Plan);
}

const indexesUsed = (plan: PlanNode[]): string[] => plan.flatMap((node) => (node['Index Name'] === undefined ? [] : [node['Index Name']]));
const hasSort = (plan: PlanNode[]): boolean => plan.some((node) => node['Node Type'].includes('Sort'));
const seqScansOnOutbox = (plan: PlanNode[]): number =>
  plan.filter((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'outbox').length;

/**
 * Volume realista: a grande maioria publicada; das pendentes, um quinto espera retry (next_attempt_at no futuro,
 * attempts > 0). Timestamps espalhados para o ANALYZE ver uma distribuição de verdade.
 */
async function seedVolume(now: Date): Promise<void> {
  await sql(
    `INSERT INTO outbox (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
     SELECT gen_random_uuid(), gen_random_uuid(), 'WalletBalanceChanged', '{"eventId":"x"}'::jsonb,
            ?::timestamptz - g * interval '1 second', 0, ?::timestamptz - g * interval '1 second',
            ?::timestamptz - g * interval '1 second' + interval '200 milliseconds'
     FROM generate_series(1, ?) AS g`,
    [now, now, now, PUBLISHED],
  );
  await sql(
    `INSERT INTO outbox (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
     SELECT gen_random_uuid(), gen_random_uuid(), 'WalletBalanceChanged', '{"eventId":"x"}'::jsonb,
            ?::timestamptz - g * interval '1 second',
            CASE WHEN g % 5 = 0 THEN 3 ELSE 0 END,
            ?::timestamptz - g * interval '1 second' + CASE WHEN g % 5 = 0 THEN interval '1 hour' ELSE interval '0' END,
            NULL
     FROM generate_series(1, ?) AS g`,
    [now, now, PENDING],
  );
  await sql(`ANALYZE outbox`);
}

describe('partial outbox indexes under realistic volume (EXPLAIN + ANALYZE)', () => {
  test('claim uses outbox_claim_idx in ORDER BY order (no Sort, no Seq Scan); lag uses outbox_pending_occurred_idx', async () => {
    const now = new Date();
    try {
      await seedVolume(now);
      const [counts] = await sql(`SELECT count(*)::int AS total, count(*) FILTER (WHERE published_at IS NULL)::int AS pending FROM outbox`);
      expect(counts).toEqual({ total: PUBLISHED + PENDING, pending: PENDING });

      const claim = await explain(CLAIM_DUE_SQL, [now, 10]);
      expect(indexesUsed(claim)).toEqual(['outbox_claim_idx']);
      expect(hasSort(claim)).toBe(false);
      expect(seqScansOnOutbox(claim)).toBe(0);

      // O min vira "primeira entrada do índice" (Limit sobre o índice), sem agregar todas as pendentes.
      const lag = await explain(OLDEST_PENDING_SQL);
      expect(indexesUsed(lag)).toEqual(['outbox_pending_occurred_idx']);
      expect(lag.some((node) => node['Node Type'] === 'Limit')).toBe(true);
      expect(lag.some((node) => node['Node Type'] === 'Aggregate')).toBe(false);
      expect(seqScansOnOutbox(lag)).toBe(0);

      // Controle: o mesmo volume com o schema anterior (índice só em next_attempt_at). O claim ordena (Incremental
      // Sort sobre next_attempt_at) e o lag lê TODAS as pendentes e agrega. Prova que as asserções acima dependem dos
      // índices novos, e não de o planner já escolher esse plano de qualquer forma.
      await orm.migrator.down({ to: PREVIOUS_MIGRATION });
      await sql(`ANALYZE outbox`);
      expect(hasSort(await explain(CLAIM_DUE_SQL, [now, 10]))).toBe(true);
      expect((await explain(OLDEST_PENDING_SQL)).some((node) => node['Node Type'] === 'Aggregate')).toBe(true);
    } finally {
      await orm.migrator.up();
      await sql(`TRUNCATE outbox`);
    }
  }, 60_000);

  test('migration 0004: down restores the previous index set, up leaves the new one (database ends on the new indexes)', async () => {
    const outboxIndexes = async (): Promise<string[]> =>
      (await sql(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'outbox' ORDER BY indexname`))
        .map((row) => row.indexname as string);
    const definition = async (name: string): Promise<string | undefined> =>
      (await sql(`SELECT indexdef FROM pg_indexes WHERE indexname = ?`, [name]))[0]?.indexdef as string | undefined;
    try {
      expect(await outboxIndexes()).toEqual(['outbox_claim_idx', 'outbox_pending_occurred_idx', 'outbox_pkey']);
      // O predicado do índice é o mesmo do WHERE das consultas: sem isso o planner não usa o índice parcial.
      expect(await definition('outbox_claim_idx')).toContain('(next_attempt_at, id) WHERE (published_at IS NULL)');
      expect(await definition('outbox_pending_occurred_idx')).toContain('(occurred_at) WHERE (published_at IS NULL)');

      await orm.migrator.down({ to: PREVIOUS_MIGRATION });
      expect(await outboxIndexes()).toEqual(['outbox_pending_idx', 'outbox_pkey']);
    } finally {
      await orm.migrator.up();
    }
    expect(await outboxIndexes()).toEqual(['outbox_claim_idx', 'outbox_pending_occurred_idx', 'outbox_pkey']);
  });
});
