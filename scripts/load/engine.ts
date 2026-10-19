/**
 * Geração de carga (modelo FECHADO: cada cliente espera a resposta antes de enviar a próxima) e contabilidade do
 * que o cliente SABE que foi aplicado. Dinheiro: só bigint em centavos.
 *
 * Regra de contabilidade: uma operação só entra no saldo esperado se foi observada como 200 PROCESSED. Erro de
 * rede, timeout e 503 ficam em `unresolved` e são reenviados ao final com a MESMA Idempotency-Key (replay seguro).
 */
import { amountFromCents } from './cents';
import { request, sleep, type HttpResult } from './http';

export type ScenarioName = 'distinct-wallets' | 'hot-wallet' | 'mixed';
export type Kind = 'BET' | 'WIN' | 'LOSS' | 'REFUND';

export interface LoadWallet {
  id: string;
  playerId: string;
  initialCents: bigint;
}

export interface Op {
  wallet: LoadWallet;
  key: string;
  kind: Kind;
  cents: bigint;
  body: Record<string, unknown>;
}

export interface Sample {
  /** ms desde o início da carga, no instante em que a resposta chegou. */
  t: number;
  ms: number;
  status: number | null;
}

export interface WalletExpectation {
  betsProcessed: number;
  betCents: bigint;
  winsProcessed: number;
  winCents: bigint;
  refundsProcessed: number;
  refundCents: bigint;
  lossesProcessed: number;
}

export class Expectations {
  readonly byWallet = new Map<string, WalletExpectation>();
  /** Transações distintas observadas como 200 PROCESSED (não conta replay). */
  processedTotal = 0;

  private state(walletId: string): WalletExpectation {
    let s = this.byWallet.get(walletId);
    if (s === undefined) {
      s = { betsProcessed: 0, betCents: 0n, winsProcessed: 0, winCents: 0n, refundsProcessed: 0, refundCents: 0n, lossesProcessed: 0 };
      this.byWallet.set(walletId, s);
    }
    return s;
  }

  apply(op: Op): void {
    const s = this.state(op.wallet.id);
    this.processedTotal++;
    if (op.kind === 'BET') {
      s.betsProcessed++;
      s.betCents += op.cents;
    } else if (op.kind === 'WIN') {
      s.winsProcessed++;
      s.winCents += op.cents;
    } else if (op.kind === 'REFUND') {
      s.refundsProcessed++;
      s.refundCents += op.cents;
    } else {
      s.lossesProcessed++; // LOSS: sem efeito no saldo e sem ledger
    }
  }

  expectedBalanceCents(wallet: LoadWallet): bigint {
    const s = this.state(wallet.id);
    return wallet.initialCents - s.betCents + s.winCents + s.refundCents;
  }

  stateOf(walletId: string): WalletExpectation {
    return this.state(walletId);
  }
}

export interface LoadContext {
  urls: readonly string[];
  scenario: ScenarioName;
  runId: string;
  wallets: readonly LoadWallet[];
  durationMs: number;
  concurrency: number;
  providerId: string;
  expectations: Expectations;
  samples: Sample[];
  unresolved: Op[];
  /** Respostas que contrariam o contrato (ex.: replay sem idempotentReplay=true). Qualquer item reprova a execução. */
  anomalies: string[];
  /** Status inesperados por tipo (400, 409 etc.): informativo, o saldo esperado não os conta. */
  unexpected: Map<string, number>;
  startedAt: number;
  replaysSent: number;
  roundRobin: number;
}

interface PendingBody {
  status?: string;
  idempotentReplay?: boolean;
}

function nextUrl(ctx: LoadContext): string {
  return ctx.urls[ctx.roundRobin++ % ctx.urls.length]!;
}

export function buildOp(ctx: LoadContext, wallet: LoadWallet, kind: Kind, cents: bigint, externalId: string, roundId: string, reference?: string): Op {
  const body: Record<string, unknown> = {
    providerId: ctx.providerId,
    externalTransactionId: externalId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId,
    gameId: 'load-game',
    kind,
    money: { amount: amountFromCents(cents), currency: 'BRL' },
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  };
  return { wallet, key: `${ctx.providerId}:${externalId}`, kind, cents, body };
}

const send = (ctx: LoadContext, op: Op): Promise<HttpResult> =>
  request('POST', nextUrl(ctx), '/wagering/transactions', { body: op.body, headers: { 'idempotency-key': op.key } });

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Envia uma operação e classifica o resultado. Devolve true se foi confirmada (200 PROCESSED). */
async function submit(ctx: LoadContext, op: Op, isReplay: boolean): Promise<boolean> {
  const res = await send(ctx, op);
  ctx.samples.push({ t: performance.now() - ctx.startedAt, ms: res.ms, status: res.status });
  if (res.status === null || res.status === 503) {
    if (!isReplay) ctx.unresolved.push(op); // pode ou não ter sido gravada: o desfecho sai do replay final
    return false;
  }
  const body = (res.body ?? {}) as PendingBody;
  if (res.status === 200 && body.status === 'PROCESSED') {
    if (isReplay) {
      if (body.idempotentReplay !== true) ctx.anomalies.push(`replay de ${op.key} voltou sem idempotentReplay=true`);
    } else {
      ctx.expectations.apply(op);
      if (body.idempotentReplay === true) ctx.anomalies.push(`primeiro envio de ${op.key} voltou como replay`);
    }
    return true;
  }
  bump(ctx.unexpected, `${op.kind} -> ${res.status}${body.status === undefined ? '' : ` ${body.status}`}`);
  return false;
}

/** Fecha as dúvidas: reenvia a mesma key das operações sem desfecho conhecido, até ter resposta definitiva. */
export async function resolveUnresolved(ctx: LoadContext): Promise<{ resolved: number; stillUnknown: Op[] }> {
  let pending = ctx.unresolved.splice(0);
  let resolved = 0;
  for (let attempt = 0; attempt < 6 && pending.length > 0; attempt++) {
    const next: Op[] = [];
    for (const op of pending) {
      const res = await send(ctx, op);
      if (res.status === null || res.status === 503) {
        next.push(op);
        continue;
      }
      resolved++;
      const body = (res.body ?? {}) as PendingBody;
      if (res.status === 200 && body.status === 'PROCESSED') ctx.expectations.apply(op);
      else bump(ctx.unexpected, `${op.kind} (reenvio) -> ${res.status}${body.status === undefined ? '' : ` ${body.status}`}`);
    }
    pending = next;
    if (pending.length > 0) await sleep(500 * (attempt + 1));
  }
  return { resolved, stillUnknown: pending };
}

const BET_CHOICES: readonly bigint[] = [100n, 250n, 500n];
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

async function client(ctx: LoadContext, clientId: number, deadline: number): Promise<void> {
  let seq = 0;
  while (performance.now() < deadline) {
    const wallet = ctx.scenario === 'hot-wallet' ? ctx.wallets[0]! : pick(ctx.wallets);
    const id = `${ctx.scenario}-c${clientId}-${seq++}`;
    const bet = buildOp(ctx, wallet, 'BET', pick(BET_CHOICES), id, `round-${id}`);
    const confirmed = await submit(ctx, bet, false);
    if (ctx.scenario !== 'mixed' || !confirmed) continue;

    if (Math.random() < 0.05) {
      ctx.replaysSent++;
      await submit(ctx, bet, true);
    }
    const roll = Math.random();
    const followKind: Kind = roll < 0.5 ? 'WIN' : roll < 0.75 ? 'LOSS' : 'REFUND';
    const followCents = followKind === 'WIN' ? bet.cents * 2n : bet.cents; // REFUND tem de ter o valor da referência
    const follow = buildOp(ctx, wallet, followKind, followCents, `${id}-${followKind.toLowerCase()}`, `round-${id}`, id);
    await submit(ctx, follow, false);
    if (Math.random() < 0.05) {
      ctx.replaysSent++;
      await submit(ctx, follow, true);
    }
  }
}

export async function runLoad(ctx: LoadContext): Promise<void> {
  ctx.startedAt = performance.now();
  const deadline = ctx.startedAt + ctx.durationMs;
  await Promise.all(Array.from({ length: ctx.concurrency }, (_, i) => client(ctx, i, deadline)));
}
