import { Migration } from '@mikro-orm/migrations';

/**
 * Fatia 9, commit 4 (ARCHITECTURE 6.8). Os dois índices são parciais com o MESMO predicado das consultas
 * (`published_at IS NULL`): o tamanho acompanha só os pendentes, e o planner só usa um índice parcial se o WHERE
 * da consulta implicar o predicado.
 * 1. Claim: `outbox_pending_idx (next_attempt_at)` vira `outbox_claim_idx (next_attempt_at, id)`. O claim ordena por
 *    `next_attempt_at, id` com LIMIT; com o `id` no índice, a leitura sai na ordem certa, sem nó Sort.
 * 2. Lag: `outbox_pending_occurred_idx (occurred_at)` para o `min(occurred_at)` do /metrics, que antes percorria
 *    todas as pendentes; com o índice, o min é a primeira entrada.
 *
 * Sem CONCURRENTLY: o MikroORM roda cada migration numa transação, onde CONCURRENTLY não é permitido. CREATE INDEX
 * comum trava ESCRITAS na outbox (lock SHARE) durante a criação, então a migration só é aceitável com o serviço parado
 * (como as demais deste projeto). Em produção com tráfego, seria uma migration fora de transação com CONCURRENTLY.
 */
export class Migration20261018000004_outbox_pending_indexes extends Migration {
  override name = 'Migration20261018000004_outbox_pending_indexes';

  override up(): void {
    this.addSql(`CREATE INDEX outbox_claim_idx ON outbox (next_attempt_at, id) WHERE published_at IS NULL`);
    this.addSql(`DROP INDEX outbox_pending_idx`);
    this.addSql(`CREATE INDEX outbox_pending_occurred_idx ON outbox (occurred_at) WHERE published_at IS NULL`);
  }

  override down(): void {
    this.addSql(`DROP INDEX outbox_pending_occurred_idx`);
    this.addSql(`CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at) WHERE published_at IS NULL`);
    this.addSql(`DROP INDEX outbox_claim_idx`);
  }
}
