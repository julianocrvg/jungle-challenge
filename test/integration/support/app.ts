import type { INestApplication, LoggerService } from '@nestjs/common';
import { type CreateAppOptions, createApp } from '../../../src/app';
import type { IdGenerator } from '../../../src/application/ports/id-generator';
import { TEST_DATABASE_URL } from './database';

/** UUIDv7 por padrão; ids enfileirados saem primeiro (para forçar colisões de forma determinística). */
export class ScriptedIdGenerator implements IdGenerator {
  private readonly queue: string[] = [];

  enqueue(...ids: string[]): void {
    this.queue.push(...ids);
  }

  next(): string {
    return this.queue.shift() ?? Bun.randomUUIDv7();
  }
}

export interface LogEntry {
  level: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';
  message: string;
}

/** Guarda os logs em memória para que o teste verifique o que foi logado. */
export class CapturingLogger implements LoggerService {
  readonly entries: LogEntry[] = [];

  log(message: unknown): void { this.push('log', message); }
  error(message: unknown): void { this.push('error', message); }
  warn(message: unknown): void { this.push('warn', message); }
  debug(message: unknown): void { this.push('debug', message); }
  verbose(message: unknown): void { this.push('verbose', message); }
  fatal(message: unknown): void { this.push('fatal', message); }

  /** Chamado num beforeEach: cada teste só enxerga os próprios logs. */
  clear(): void { this.entries.length = 0; }

  private push(level: LogEntry['level'], message: unknown): void {
    this.entries.push({ level, message: String(message) });
  }
}

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: T;
}

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  ids: ScriptedIdGenerator;
  logger: CapturingLogger;
  post<T = Record<string, unknown>>(path: string, body: unknown, headers?: Record<string, string>): Promise<HttpResult<T>>;
  close(): Promise<void>;
}

/** Sobe a API de verdade (Nest + Postgres de teste) numa porta livre. O schema deve ter sido criado antes. */
export async function startTestApp(options: CreateAppOptions = {}): Promise<TestApp> {
  const ids = new ScriptedIdGenerator();
  const logger = new CapturingLogger();
  const app = await createApp({
    idGenerator: ids,
    logger,
    ...options,
    database: { url: TEST_DATABASE_URL, ...options.database },
    // Desligado por padrão: os testes de HTTP conferem a outbox e não podem ter um publisher concorrente.
    outbox: { enabled: false, ...options.outbox },
    // Idem para o consumidor: os testes da fila montam o seu, com filas temporárias.
    consumer: { enabled: false, ...options.consumer },
  });
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  return {
    app,
    baseUrl,
    ids,
    logger,
    async post<T>(path: string, body: unknown, headers: Record<string, string> = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, headers: response.headers, body: (await response.json()) as T };
    },
    close: () => app.close(),
  };
}

export interface WalletBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export async function createWalletViaApi(api: TestApp, amount = '100.00', currency = 'BRL'): Promise<WalletBody> {
  const result = await api.post<WalletBody>('/wallets', {
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount, currency },
  });
  if (result.status !== 201) throw new Error(`wallet creation failed: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

export interface TransactionBody {
  transactionId: string;
  status: string;
  failureCode: string | null;
  /** `null` em PENDING_REFERENCE. */
  balance: { amount: string; currency: string } | null;
  idempotentReplay: boolean;
}

/** Corpo de uma submissão: o da transação (200/422) ou o de erro (`{code, message}`). */
export type SubmissionBody = Partial<TransactionBody> & { code?: string; message?: string };

export function wagerPayload(wallet: WalletBody, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** Submete com a Idempotency-Key padrão `{providerId}:{externalTransactionId}`, salvo se outra for passada. */
export function submit(
  api: TestApp,
  payload: Record<string, unknown>,
  idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`,
): Promise<HttpResult<SubmissionBody>> {
  return api.post<SubmissionBody>('/wagering/transactions', payload, { 'idempotency-key': idempotencyKey });
}
