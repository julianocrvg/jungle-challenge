/**
 * Espera a outbox drenar. Critério de fim: ZERO linhas pendentes no banco (published_at IS NULL), não o lag (que
 * tem cache de 5 s no scrape, ARCHITECTURE 11.4). Sem acesso ao banco, cai para "outbox_published_total parou de
 * crescer por 3 amostras seguidas" (menos preciso; o relatório diz qual critério valeu).
 */
import { SQL } from 'bun';
import { sleep } from './http';
import { scrapeAll } from './metrics';
import { sumDelta, counterDeltas } from './stats';

export interface DrainResult {
  drained: boolean;
  drainMs: number;
  criterion: 'db-pending-count' | 'published-total-stable';
  pendingAtStart: number | null;
}

export class OutboxProbe {
  private sql: SQL | null = null;

  constructor(databaseUrl: string | undefined) {
    if (databaseUrl !== undefined) this.sql = new SQL(databaseUrl);
  }

  /** Linhas pendentes, ou null se o banco não responde. */
  async pending(): Promise<number | null> {
    if (this.sql === null) return null;
    try {
      const rows = await this.sql`SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`;
      return (rows[0] as { n: number }).n;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.sql?.close();
  }
}

export async function waitForDrain(probe: OutboxProbe, urls: readonly string[], timeoutMs: number): Promise<DrainResult> {
  const started = performance.now();
  const first = await probe.pending();
  if (first !== null) {
    let pending: number | null = first;
    while (pending !== 0 && performance.now() - started < timeoutMs) {
      await sleep(250);
      pending = await probe.pending();
    }
    return { drained: pending === 0, drainMs: performance.now() - started, criterion: 'db-pending-count', pendingAtStart: first };
  }

  // Fallback: sem banco, observa o contador publicado até estabilizar.
  const base = await scrapeAll(urls);
  let last = -1;
  let stable = 0;
  while (stable < 3 && performance.now() - started < timeoutMs) {
    await sleep(1000);
    const published = sumDelta(counterDeltas(base, await scrapeAll(urls)).deltas, 'outbox_published_total');
    stable = published === last ? stable + 1 : 0;
    last = published;
  }
  return { drained: stable >= 3, drainMs: performance.now() - started, criterion: 'published-total-stable', pendingAtStart: null };
}
