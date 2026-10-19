/**
 * Teste de carga (opcional do enunciado): `bun run test:load`. Fora do `bun test`.
 * Usa o banco e as filas de DESENVOLVIMENTO (wagering), contra instâncias já no ar (LOAD_URLS). Não sobe nem derruba nada.
 * Modelo FECHADO: N clientes, cada um espera a resposta antes da próxima (sujeito a coordinated omission; ver ARCHITECTURE 16).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { amountFromCents } from './cents';
import { OutboxProbe, waitForDrain, type DrainResult } from './drain';
import { collectEnvironment } from './env-info';
import { Expectations, resolveUnresolved, runLoad, type LoadContext, type ScenarioName } from './engine';
import { sleep } from './http';
import { LagSampler, scrapeAll } from './metrics';
import {
  bucketQuantile, counterDeltas, histogramBuckets, minMedMax, round1, sumDelta, sumDeltaBy, summarizeLatencies,
  tallyStatuses, type LatencySummary,
} from './stats';
import { setupWallets, verifyWallets } from './verify';

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10); // configuração (segundos, contagens), nunca dinheiro
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} inválido: ${raw}`);
  return n;
};

const urls = (process.env.LOAD_URLS ?? 'http://localhost:3000').split(',').map((u) => u.trim().replace(/\/$/, '')).filter((u) => u !== '');
const durationS = int('LOAD_DURATION_S', 30);
const warmupS = int('LOAD_WARMUP_S', 3);
const concurrency = int('LOAD_CONCURRENCY', 32);
const walletCount = int('LOAD_WALLETS', 200);
const repeats = int('LOAD_REPEATS', 1);
const drainTimeoutS = int('LOAD_DRAIN_TIMEOUT_S', 120);
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5433/wagering';
const scenarios = (process.env.LOAD_SCENARIOS ?? 'distinct-wallets,hot-wallet,mixed').split(',').map((s) => s.trim()) as ScenarioName[];
const INITIAL_CENTS = 1_000_000_000n; // 10.000.000,00: nunca rejeita por saldo na duração configurada

interface RunResult {
  scenario: ScenarioName;
  repeat: number;
  wallets: number;
  clients: number;
  durationS: number;
  warmupS: number;
  requests: number;
  statuses: Record<string, number>;
  unexpected: Record<string, number>;
  throughputPerS: number;
  latencyMs: LatencySummary;
  server: {
    httpP50Ms: number | null;
    httpP95Ms: number | null;
    httpP99Ms: number | null;
    httpMeanMs: number | null;
    lockConflictsBySqlstate: Record<string, number>;
    transactionsByStatus: Record<string, number>;
    duplicatesBySource: Record<string, number>;
    outboxPublished: number;
    maxOutboxLagSeconds: number;
  };
  outbox: DrainResult & { pendingAtEndOfLoad: number | null };
  replaysSent: number;
  unresolvedReplayed: number;
  verification: { walletsChecked: number; ledgerEntriesChecked: number; divergences: string[] };
  failures: string[];
}

async function runOnce(scenario: ScenarioName, repeat: number, probe: OutboxProbe): Promise<RunResult> {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const walletsN = scenario === 'hot-wallet' ? 1 : walletCount;
  const label = `${scenario}#${repeat}`;
  console.log(`\n[${label}] criando ${walletsN} wallet(s)...`);
  const wallets = await setupWallets(urls, walletsN, runId, INITIAL_CENTS);

  // O setup também gera eventos na outbox: drena antes para medir só o que a carga produziu.
  await waitForDrain(probe, urls, drainTimeoutS * 1000);
  const before = await scrapeAll(urls);

  const ctx: LoadContext = {
    urls, scenario, runId, wallets, durationMs: durationS * 1000, concurrency, providerId: `load-${runId}`,
    expectations: new Expectations(), samples: [], unresolved: [], anomalies: [], unexpected: new Map(),
    startedAt: 0, replaysSent: 0, roundRobin: 0,
  };
  console.log(`[${label}] carga: ${concurrency} clientes por ${durationS}s...`);
  const lag = new LagSampler(urls);
  await runLoad(ctx);
  const afterLoad = await scrapeAll(urls);
  const pendingAtEndOfLoad = await probe.pending();

  const { resolved, stillUnknown } = await resolveUnresolved(ctx);
  console.log(`[${label}] drenando a outbox (pendentes ao fim da carga: ${pendingAtEndOfLoad ?? 'n/d'})...`);
  const drain = await waitForDrain(probe, urls, drainTimeoutS * 1000);
  await lag.stop();
  const final = await scrapeAll(urls);

  console.log(`[${label}] verificando a correção...`);
  const verification = await verifyWallets(urls, wallets, ctx.expectations);

  const loadDeltas = counterDeltas(before, afterLoad);
  const finalDeltas = counterDeltas(before, final);
  const failures: string[] = [...verification.divergences, ...ctx.anomalies];
  if (stillUnknown.length > 0) failures.push(`${stillUnknown.length} operações sem desfecho após os reenvios (conta não fecha)`);
  if (finalDeltas.resets.length > 0) failures.push(`contadores diminuíram (instância reiniciada?): ${finalDeltas.resets.slice(0, 3).join('; ')}`);
  const serverProcessed = sumDelta(finalDeltas.deltas, 'wager_transactions_total', { status: 'PROCESSED' });
  if (serverProcessed !== ctx.expectations.processedTotal) {
    failures.push(`wager_transactions_total{PROCESSED} +${serverProcessed} != ${ctx.expectations.processedTotal} observadas pelo cliente (há outro tráfego no ambiente?)`);
  }
  if (!drain.drained) failures.push(`outbox não drenou em ${drainTimeoutS}s (informativo: não é violação de invariante)`);

  const route = { route: '/wagering/transactions' };
  const buckets = histogramBuckets(loadDeltas.deltas, 'http_request_duration_seconds', route);
  const sumS = sumDelta(loadDeltas.deltas, 'http_request_duration_seconds_sum', route);
  const countS = sumDelta(loadDeltas.deltas, 'http_request_duration_seconds_count', route);
  const toMs = (s: number | null): number | null => (s === null ? null : round1(s * 1000));

  const warmupMs = warmupS * 1000;
  const measured = ctx.samples.filter((s) => s.t >= warmupMs && s.t <= ctx.durationMs);
  const ok = measured.filter((s) => s.status !== null && s.status >= 200 && s.status < 300).length;
  const window = Math.max(1, durationS - warmupS);
  const latency = summarizeLatencies(measured.filter((s) => s.status !== null).map((s) => s.ms));

  let maxLag = lag.maxLagSeconds;
  maxLag = Math.round(maxLag * 10) / 10;

  return {
    scenario, repeat, wallets: walletsN, clients: concurrency, durationS, warmupS,
    requests: ctx.samples.length,
    statuses: tallyStatuses(ctx.samples.map((s) => s.status)),
    unexpected: Object.fromEntries(ctx.unexpected),
    throughputPerS: round1(ok / window),
    latencyMs: {
      count: latency.count,
      p50: latency.p50 === null ? null : round1(latency.p50),
      p95: latency.p95 === null ? null : round1(latency.p95),
      p99: latency.p99 === null ? null : round1(latency.p99),
      max: latency.max === null ? null : round1(latency.max),
    },
    server: {
      httpP50Ms: toMs(bucketQuantile(0.5, buckets)),
      httpP95Ms: toMs(bucketQuantile(0.95, buckets)),
      httpP99Ms: toMs(bucketQuantile(0.99, buckets)),
      httpMeanMs: countS > 0 ? round1((sumS / countS) * 1000) : null,
      lockConflictsBySqlstate: sumDeltaBy(finalDeltas.deltas, 'db_lock_conflicts_total', 'sqlstate'),
      transactionsByStatus: sumDeltaBy(finalDeltas.deltas, 'wager_transactions_total', 'status'),
      duplicatesBySource: sumDeltaBy(finalDeltas.deltas, 'wager_duplicates_total', 'source'),
      outboxPublished: sumDelta(finalDeltas.deltas, 'outbox_published_total'),
      maxOutboxLagSeconds: maxLag,
    },
    outbox: { ...drain, drainMs: Math.round(drain.drainMs), pendingAtEndOfLoad },
    replaysSent: ctx.replaysSent,
    unresolvedReplayed: resolved,
    verification: {
      walletsChecked: verification.walletsChecked,
      ledgerEntriesChecked: verification.ledgerEntriesChecked,
      divergences: verification.divergences,
    },
    failures,
  };
}

function printRun(r: RunResult): void {
  const s = r.statuses;
  console.log(`\n== ${r.scenario} #${r.repeat} (${r.wallets} wallets, ${r.clients} clientes, ${r.durationS}s, aquecimento ${r.warmupS}s) ==`);
  console.log(`  requisições: ${r.requests} | 200:${s['200']} 202:${s['202']} 409:${s['409']} 422:${s['422']} 503:${s['503']} outros:${s.other} rede:${s.network}`);
  console.log(`  throughput: ${r.throughputPerS} resp. 2xx/s`);
  console.log(`  latência cliente (ms): p50 ${r.latencyMs.p50} | p95 ${r.latencyMs.p95} | p99 ${r.latencyMs.p99} | max ${r.latencyMs.max}`);
  console.log(`  latência servidor POST (ms): média ${r.server.httpMeanMs} | p50 ${r.server.httpP50Ms} | p95 ${r.server.httpP95Ms} | p99 ${r.server.httpP99Ms}`);
  console.log(`  conflitos de lock: ${JSON.stringify(r.server.lockConflictsBySqlstate)} | duplicatas: ${JSON.stringify(r.server.duplicatesBySource)} | transações: ${JSON.stringify(r.server.transactionsByStatus)}`);
  console.log(`  outbox: publicados ${r.server.outboxPublished} | lag máx ${r.server.maxOutboxLagSeconds}s | pendentes ao fim da carga ${r.outbox.pendingAtEndOfLoad} | drenagem ${r.outbox.drained ? `${r.outbox.drainMs} ms` : 'NÃO DRENOU'} (${r.outbox.criterion})`);
  if (Object.keys(r.unexpected).length > 0) console.log(`  respostas não-200: ${JSON.stringify(r.unexpected)}`);
  console.log(`  verificação: ${r.verification.walletsChecked} wallets, ${r.verification.ledgerEntriesChecked} lançamentos, ${r.verification.divergences.length} divergências`);
  for (const f of r.failures) console.log(`  ✗ ${f}`);
}

function printSummary(results: RunResult[]): void {
  console.log('\n== Resumo (min / mediana / máx entre as repetições) ==');
  const fmt = (v: { min: number; median: number; max: number } | null): string => (v === null ? 'n/d' : `${round1(v.min)} / ${round1(v.median)} / ${round1(v.max)}`);
  for (const name of scenarios) {
    const runs = results.filter((r) => r.scenario === name);
    const vals = (f: (r: RunResult) => number | null): number[] => runs.map(f).filter((x): x is number => x !== null);
    console.log(`  ${name} (${runs.length} execuções)`);
    console.log(`    throughput 2xx/s: ${fmt(minMedMax(vals((r) => r.throughputPerS)))}`);
    console.log(`    p50 ms: ${fmt(minMedMax(vals((r) => r.latencyMs.p50)))} | p95 ms: ${fmt(minMedMax(vals((r) => r.latencyMs.p95)))} | p99 ms: ${fmt(minMedMax(vals((r) => r.latencyMs.p99)))}`);
    console.log(`    drenagem ms: ${fmt(minMedMax(vals((r) => (r.outbox.drained ? r.outbox.drainMs : null))))}`);
  }
}

async function main(): Promise<void> {
  if (urls.length === 0) throw new Error('LOAD_URLS vazio');
  for (const s of scenarios) {
    if (!['distinct-wallets', 'hot-wallet', 'mixed'].includes(s)) throw new Error(`cenário desconhecido: ${s}`);
  }
  console.log(`Alvos: ${urls.join(', ')} | banco de desenvolvimento (NÃO wagering_test) | saldo inicial por wallet ${amountFromCents(INITIAL_CENTS)}`);
  const environment = await collectEnvironment(urls);
  const probe = new OutboxProbe(databaseUrl);
  const results: RunResult[] = [];
  try {
    for (const scenario of scenarios) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        const result = await runOnce(scenario, repeat, probe);
        printRun(result);
        results.push(result);
        await sleep(1000);
      }
    }
  } finally {
    await probe.close();
  }
  printSummary(results);

  mkdirSync('load-results', { recursive: true });
  const file = `load-results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const config = { urls, durationS, warmupS, concurrency, walletCount, repeats, drainTimeoutS, model: 'closed' };
  writeFileSync(file, JSON.stringify({ environment, config, results }, null, 2));
  console.log(`\nRelatório: ${file}`);

  // Drenagem lenta é informativa; só divergência de correção reprova.
  const hard = results.flatMap((r) => r.failures.filter((f) => !f.startsWith('outbox não drenou')).map((f) => `${r.scenario}#${r.repeat}: ${f}`));
  if (hard.length > 0) {
    console.error(`\nFALHA DE CORREÇÃO (${hard.length}):`);
    for (const f of hard.slice(0, 30)) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nCorreção sob carga: OK (todas as wallets reconciliadas, ledger e saldo batem com o cliente).');
}

await main();
