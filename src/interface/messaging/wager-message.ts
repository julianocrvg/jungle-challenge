import type { WagerTransactionPayload } from '../../application/wagering/submit-wager-transaction';
import { parseIdempotencyKey, parseWagerTransactionPayload, RequestValidationError } from '../http/validation';

/*
 * Envelope da fila wager-transactions.fifo (enunciado, seção 10). `data` passa pelo MESMO validador do HTTP,
 * então OPENING, o provider `internal` e campos desconhecidos são recusados do mesmo jeito. `messageId`, `type`
 * e `occurredAt` são transporte: nunca entram no payloadHash (ARCHITECTURE 7.1).
 */

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/** Motivo gravado no atributo `failureReason` da mensagem na DLQ. */
export type InvalidMessageReason = 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'UNKNOWN_MESSAGE_TYPE' | 'INVALID_PAYLOAD';

/** Mensagem que nunca vai ser processável: erro permanente, vai para a DLQ. */
export class InvalidMessageError extends Error {
  constructor(readonly reason: InvalidMessageReason, readonly details: string[]) {
    super(`Invalid message (${reason}): ${details.join('; ')}`);
    this.name = 'InvalidMessageError';
  }
}

export interface WagerMessage {
  messageId: string;
  occurredAt: Date;
  idempotencyKey: string;
  payload: WagerTransactionPayload;
}

const ENVELOPE_FIELDS = ['messageId', 'type', 'occurredAt', 'data'];
/** Mesmo alfabeto da Idempotency-Key: ASCII visível, até 255. */
const MESSAGE_ID = /^[\x21-\x7E]{1,255}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseWagerMessage(body: string): WagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidMessageError('INVALID_JSON', ['body is not valid JSON']);
  }

  // Envelope estrito, como o corpo HTTP: um campo desconhecido pode carregar significado que o hash ignoraria.
  if (!isObject(parsed)) throw new InvalidMessageError('INVALID_ENVELOPE', ['body must be an object']);
  const errors = Object.keys(parsed).filter((key) => !ENVELOPE_FIELDS.includes(key)).map((key) => `${key} is not allowed`);
  const { messageId, type, occurredAt, data } = parsed;
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) {
    errors.push('messageId must be 1 to 255 visible ASCII characters');
  }
  const occurred = typeof occurredAt === 'string' && ISO_8601.test(occurredAt) ? new Date(occurredAt) : undefined;
  if (occurred === undefined || Number.isNaN(occurred.getTime())) errors.push('occurredAt must be an ISO-8601 timestamp');
  if (!isObject(data)) errors.push('data must be an object');
  if (errors.length > 0) throw new InvalidMessageError('INVALID_ENVELOPE', errors);
  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidMessageError('UNKNOWN_MESSAGE_TYPE', [`type must be ${WAGER_TRANSACTION_REQUESTED}`]);
  }

  // `idempotencyKey` vem em `data` (enunciado) mas é o equivalente do header: sai antes da validação do payload
  // e nunca entra no payloadHash. Ausente: o default `{providerId}:{externalTransactionId}`.
  const { idempotencyKey, ...business } = data as Record<string, unknown>;
  try {
    const payload = parseWagerTransactionPayload(business);
    const key = parseIdempotencyKey(idempotencyKey ?? `${payload.providerId}:${payload.externalTransactionId}`);
    return { messageId: messageId as string, occurredAt: occurred as Date, idempotencyKey: key, payload };
  } catch (error) {
    if (error instanceof RequestValidationError) throw new InvalidMessageError('INVALID_PAYLOAD', error.details);
    throw error;
  }
}
