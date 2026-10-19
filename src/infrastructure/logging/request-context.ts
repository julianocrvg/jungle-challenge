import { AsyncLocalStorage } from 'node:async_hooks';
import type { LogFields } from '../../application/ports/structured-logger';

/**
 * Contexto de log da requisição HTTP ou da mensagem SQS (ARCHITECTURE 11.3). É um objeto **mutável** guardado num
 * `AsyncLocalStorage`: o middleware (ou o consumidor) abre o contexto com o `correlationId` e quem descobre os ids
 * depois (`walletId`, `transactionId`, `providerId`, `messageId`) os preenche com `enrichContext`, sem abrir outro
 * `run`. Todo log feito por `NestStructuredLogger` dentro desse fluxo carrega os campos preenchidos.
 */
export interface LogContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Formato aceito para um `X-Correlation-Id` vindo do cliente: curto e sem caracteres de controle ou espaço. */
const CORRELATION_ID_FORMAT = /^[A-Za-z0-9._:-]{1,64}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_ID_FORMAT.test(value);
}

export function runWithContext<T>(context: LogContext, work: () => T): T {
  return storage.run(context, work);
}

export function currentContext(): LogContext | undefined {
  return storage.getStore();
}

/** Preenche campos do contexto atual (se houver um). Valores `undefined` são ignorados. */
export function enrichContext(fields: Partial<LogContext>): void {
  const context = storage.getStore();
  if (context === undefined) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (context as unknown as Record<string, string>)[key] = value;
  }
}

/** Os campos do contexto atual, só os preenchidos, prontos para o log. */
export function contextFields(): LogFields {
  const context = storage.getStore();
  return context === undefined ? {} : { ...context };
}
