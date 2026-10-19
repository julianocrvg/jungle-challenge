import { type LogFields, SAFE_ERROR_NAME } from '../../application/ports/structured-logger';
import { constraintOf, sqlStateOf } from '../persistence/database-errors';

/*
 * Whitelist pura (ARCHITECTURE 11.2): nunca devolve `message`, nem o `detail` do erro do pg, nem a query do
 * MikroORM. A mensagem de um erro inesperado é texto livre (um bug, ou o Postgres citando o valor que recusou).
 * Cada campo só sai se casar com um formato fechado; o que não casa vira ausente.
 */

const SQL_STATE = /^[0-9A-Z]{5}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const CONSTRAINT = /^[a-z0-9_]{1,63}$/;
const FRAME = /^\s+at \S/;

export const MAX_FRAMES = 10;
export const MAX_FRAME_LENGTH = 200;
export const MAX_CAUSE_DEPTH = 3;
export const MAX_CAUSES = 5;

export interface ErrorSummary {
  errorName: string;
  sqlState?: string;
  code?: string;
  constraint?: string;
}

export interface ErrorDescription extends ErrorSummary {
  frames: string[];
  /** Causas encadenadas (`cause`) e filhas de `AggregateError`, com o mesmo filtro e profundidade limitada. */
  causes: ErrorSummary[];
}

/** Lê uma propriedade sem deixar um getter que lança escapar. */
function read(source: unknown, key: string): unknown {
  try {
    return (source as Record<string, unknown> | null | undefined)?.[key];
  } catch {
    return undefined;
  }
}

function summarize(thrown: unknown): ErrorSummary {
  const isObject = typeof thrown === 'object' && thrown !== null;
  const rawName = isObject ? read(thrown, 'name') : undefined;
  // Sem stringificar um throwable que não é Error: só o tipo.
  const errorName = typeof rawName === 'string' && SAFE_ERROR_NAME.test(rawName) ? rawName : isObject && thrown instanceof Error ? 'Error' : `NonError_${typeof thrown}`;
  // Todo SQLSTATE tem ao menos um dígito; `EPIPE` (5 letras) é um code de socket, não um SQLSTATE.
  const candidateState = isObject ? sqlStateOfSafe(thrown) : undefined;
  const sqlState = candidateState !== undefined && SQL_STATE.test(candidateState) && /\d/.test(candidateState) ? candidateState : undefined;
  const rawCode = isObject ? read(thrown, 'code') : undefined;
  const code = typeof rawCode === 'string' && CODE.test(rawCode) && rawCode !== sqlState ? rawCode : undefined;
  const rawConstraint = isObject ? constraintOfSafe(thrown) : undefined;
  const constraint = rawConstraint !== undefined && CONSTRAINT.test(rawConstraint) ? rawConstraint : undefined;
  return {
    errorName,
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(code === undefined ? {} : { code }),
    ...(constraint === undefined ? {} : { constraint }),
  };
}

function sqlStateOfSafe(thrown: unknown): string | undefined {
  try {
    return sqlStateOf(thrown);
  } catch {
    return undefined;
  }
}

function constraintOfSafe(thrown: unknown): string | undefined {
  try {
    return constraintOf(thrown);
  } catch {
    return undefined;
  }
}

/**
 * Os frames `at ...` do stack. A primeira parte do `stack` repete `Nome: mensagem`, e a mensagem pode ter várias
 * linhas, até com `\n    at 100.00 (a:1:1)` forjado. Por isso o cabeçalho só é removido se o stack começa
 * exatamente por ele (nome + ": " + mensagem, pelo tamanho); se não começa (mensagem alterada depois da captura,
 * formato desconhecido), não há frames. A mensagem é usada só para medir o que descartar, nunca é devolvida.
 */
export function framesOf(error: Error): string[] {
  try {
    const stack = error.stack;
    const message = error.message;
    if (typeof stack !== 'string' || typeof message !== 'string') return [];
    // `name = ...` atribuído depois do super() não muda o cabeçalho já capturado ("Error: ..."): aceita os dois.
    const names = new Set(['Error', safeName(error), safeName(error.constructor)]);
    const header = [...names]
      .filter((name): name is string => name !== undefined)
      .map((name) => (message === '' ? name : `${name}: ${message}`))
      .find((candidate) => stack.startsWith(candidate) && (stack.length === candidate.length || stack[candidate.length] === '\n'));
    if (header === undefined) return [];
    return stack
      .slice(header.length)
      .split('\n')
      .filter((line) => FRAME.test(line))
      .slice(0, MAX_FRAMES)
      .map((line) => line.trim().slice(0, MAX_FRAME_LENGTH));
  } catch {
    return [];
  }
}

function safeName(source: unknown): string | undefined {
  const name = read(source, 'name');
  return typeof name === 'string' ? name : undefined;
}

function collectCauses(thrown: unknown, depth: number, seen: WeakSet<object>, out: ErrorSummary[]): void {
  if (depth > MAX_CAUSE_DEPTH || typeof thrown !== 'object' || thrown === null) return;
  if (seen.has(thrown)) return;
  seen.add(thrown);
  const children: unknown[] = [];
  const cause = read(thrown, 'cause');
  if (cause !== undefined) children.push(cause);
  const errors = read(thrown, 'errors');
  if (thrown instanceof AggregateError && Array.isArray(errors)) children.push(...errors.slice(0, MAX_CAUSES));
  for (const child of children) {
    if (out.length >= MAX_CAUSES) return;
    out.push(summarize(child));
    collectCauses(child, depth + 1, seen, out);
  }
}

/**
 * Total: nunca lança. `instanceof` sobre um Proxy revogado (ou com trap que lança) estoura fora dos acessos
 * protegidos por `read`, e um log de erro não pode derrubar quem está tratando o erro.
 */
export function describeError(thrown: unknown): ErrorDescription {
  try {
    const summary = summarize(thrown);
    const frames = thrown instanceof Error ? framesOf(thrown) : [];
    const causes: ErrorSummary[] = [];
    collectCauses(thrown, 1, new WeakSet<object>(), causes);
    return { ...summary, frames, causes };
  } catch {
    return { errorName: 'Error', frames: [], causes: [] };
  }
}

function labelOf(summary: ErrorSummary): string {
  const detail = summary.sqlState ?? summary.code;
  return detail === undefined ? summary.errorName : `${summary.errorName}:${detail}`;
}

/** O `describeError` achatado em campos de log (a porta só aceita primitivos). Total, como o `describeError`. */
export function errorFields(thrown: unknown): LogFields {
  try {
    const description = describeError(thrown);
    // Sem chaves `undefined`: espalhado sobre o contexto do log, uma chave ausente não pode apagar uma que existe.
    const fields: Record<string, string> = { errorName: description.errorName };
    if (description.frames.length > 0) fields.stack = description.frames.join('\n');
    if (description.sqlState !== undefined) fields.sqlState = description.sqlState;
    if (description.code !== undefined) fields.code = description.code;
    if (description.constraint !== undefined) fields.constraint = description.constraint;
    if (description.causes.length > 0) fields.causes = description.causes.map(labelOf).join(',');
    return fields;
  } catch {
    return { errorName: 'Error' };
  }
}
