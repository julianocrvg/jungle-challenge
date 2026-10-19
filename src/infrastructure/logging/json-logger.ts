import type { LoggerService } from '@nestjs/common';
import { errorFields } from './describe-error';

type Level = 'info' | 'warn' | 'error' | 'debug' | 'verbose' | 'fatal';

const SEVERITY: Record<Level, number> = { verbose: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

/** `LOG_LEVEL` (default `info`): debug e verbose só saem com `LOG_LEVEL=debug` (ou `verbose`). */
export function logLevelFromEnv(env: Record<string, string | undefined> = process.env): Level {
  const value = env.LOG_LEVEL?.toLowerCase();
  return value !== undefined && value in SEVERITY ? (value as Level) : 'info';
}

/** Um contexto de logger é um nome curto (`WagerConsumer`); um stack ou um texto livre nunca casa. */
const CONTEXT = /^[A-Za-z][\w.-]{0,63}$/;
const RESERVED = new Set(['timestamp', 'level', 'context', 'message']);

/**
 * Logger do Nest que escreve em stdout uma linha JSON por entrada (ARCHITECTURE 11.2). O stack que o Nest passa em
 * `error(message, stack, context)` é descartado: só o último parâmetro, e só se tiver forma de nome de contexto,
 * vira `context`. Um `Error` recebido como mensagem sai por `errorFields` (nome, SQLSTATE, constraint e frames).
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
    private readonly minLevel: Level = logLevelFromEnv(),
  ) {}

  log(message: unknown, ...params: unknown[]): void { this.emit('info', message, params); }
  error(message: unknown, ...params: unknown[]): void { this.emit('error', message, params); }
  warn(message: unknown, ...params: unknown[]): void { this.emit('warn', message, params); }
  debug(message: unknown, ...params: unknown[]): void { this.emit('debug', message, params); }
  verbose(message: unknown, ...params: unknown[]): void { this.emit('verbose', message, params); }
  fatal(message: unknown, ...params: unknown[]): void { this.emit('fatal', message, params); }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] < SEVERITY[this.minLevel]) return;
    const last = params.at(-1);
    const context = typeof last === 'string' && CONTEXT.test(last) ? last : undefined;
    const { text, fields } = split(message);
    const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => !RESERVED.has(key)));
    this.write(serialize({ timestamp: new Date().toISOString(), level, context, message: text, ...rest }));
  }
}

function split(message: unknown): { text: string; fields: Record<string, unknown> } {
  if (typeof message === 'string') return { text: message, fields: {} };
  if (message instanceof Error) return { text: 'error', fields: errorFields(message) };
  if (typeof message === 'object' && message !== null) {
    const { message: text, ...fields } = message as Record<string, unknown>;
    return { text: typeof text === 'string' ? text : '', fields };
  }
  if (typeof message === 'number' || typeof message === 'boolean' || typeof message === 'bigint') {
    return { text: String(message), fields: {} };
  }
  return { text: '', fields: {} };
}

function serialize(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) return errorFields(value);
      return value;
    });
  } catch {
    // Ciclo ou valor não serializável: o log não pode derrubar quem o chamou.
    return JSON.stringify({ timestamp: entry.timestamp, level: entry.level, message: 'log entry not serializable' });
  }
}
