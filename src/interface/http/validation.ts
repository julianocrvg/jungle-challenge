import { currentContext, isValidCorrelationId } from '../../infrastructure/logging/request-context';
import type { WagerTransactionPayload } from '../../application/wagering/submit-wager-transaction';
import { DomainError } from '../../domain/errors';
import { Money, type MoneyProps } from '../../domain/money';
import { INTERNAL_PROVIDER_ID, isReservedProviderId, WagerTransactionKind } from '../../domain/wager-transaction';

/*
 * Validação estrita, escrita à mão (sem dependência nova, ARCHITECTURE 5.9). Campos desconhecidos são
 * recusados: eles não entram no hash e mudariam o significado da requisição sem mudar a idempotência.
 */

export class RequestValidationError extends Error {
  readonly code = 'INVALID_PAYLOAD';

  constructor(readonly details: string[]) {
    super('Invalid request');
    this.name = 'RequestValidationError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ASCII visível, de 1 a 255 caracteres. */
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;
const RESERVED_KEY_PREFIX = `${INTERNAL_PROVIDER_ID}:`;
const MAX_ID_LENGTH = 128;
const SUBMITTABLE_KINDS: readonly string[] = [
  WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
  WagerTransactionKind.Refund, WagerTransactionKind.Rollback,
];

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class Checker {
  readonly errors: string[] = [];

  object(value: unknown, path: string, allowed: readonly string[]): JsonObject {
    if (!isObject(value)) {
      this.errors.push(`${path} must be an object`);
      return {};
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.errors.push(`${path === 'body' ? key : `${path}.${key}`} is not allowed`);
    }
    return value;
  }

  text(value: unknown, path: string, optional = false): string | undefined {
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_LENGTH) {
      this.errors.push(`${path} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
      return undefined;
    }
    return value;
  }

  uuid(value: unknown, path: string): string | undefined {
    if (typeof value !== 'string' || !UUID.test(value)) {
      this.errors.push(`${path} must be a UUID`);
      return undefined;
    }
    return value.toLowerCase();
  }

  money(value: unknown, path: string): MoneyProps | undefined {
    const object = this.object(value, path, ['amount', 'currency']);
    if (!isObject(value)) return undefined;
    try {
      // Money.from aplica a regex estrita: só string, 2 casas, sem sinal nem notação científica.
      return Money.from({ amount: object.amount as string, currency: object.currency as string }).toJSON();
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.errors.push(`${path}: ${error.message}`);
      return undefined;
    }
  }

  done<T>(result: T): T {
    if (this.errors.length > 0) throw new RequestValidationError(this.errors);
    return result;
  }
}

export function parseIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY.test(header)) {
    throw new RequestValidationError(['Idempotency-Key header is required: 1 to 255 visible ASCII characters']);
  }
  if (header.toLowerCase().startsWith(RESERVED_KEY_PREFIX)) {
    throw new RequestValidationError([`Idempotency-Key prefix "${RESERVED_KEY_PREFIX}" is reserved`]);
  }
  return header;
}

export function parseWagerTransactionPayload(body: unknown): WagerTransactionPayload {
  const c = new Checker();
  const o = c.object(body, 'body', [
    'providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money',
    'referenceExternalTransactionId',
  ]);
  const providerId = c.text(o.providerId, 'providerId');
  if (providerId !== undefined && isReservedProviderId(providerId)) {
    c.errors.push(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
  }
  const kind = o.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.includes(kind)) {
    c.errors.push(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }
  const reference = c.text(o.referenceExternalTransactionId, 'referenceExternalTransactionId', true);
  if (reference === undefined && (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback)) {
    c.errors.push(`${kind} requires referenceExternalTransactionId`);
  }
  if (reference !== undefined && kind === WagerTransactionKind.Bet) {
    c.errors.push('BET cannot carry referenceExternalTransactionId');
  }
  const payload = {
    providerId: providerId as string,
    externalTransactionId: c.text(o.externalTransactionId, 'externalTransactionId') as string,
    playerId: c.uuid(o.playerId, 'playerId') as string,
    walletId: c.uuid(o.walletId, 'walletId') as string,
    roundId: c.text(o.roundId, 'roundId') as string,
    gameId: c.text(o.gameId, 'gameId') as string,
    kind: kind as WagerTransactionKind,
    money: c.money(o.money, 'money') as MoneyProps,
    ...(reference === undefined ? {} : { referenceExternalTransactionId: reference }),
  };
  return c.done(payload);
}

export function parseCreateWalletRequest(body: unknown): { playerId: string; initialBalance: MoneyProps } {
  const c = new Checker();
  const o = c.object(body, 'body', ['playerId', 'initialBalance']);
  return c.done({
    playerId: c.uuid(o.playerId, 'playerId') as string,
    initialBalance: c.money(o.initialBalance, 'initialBalance') as MoneyProps,
  });
}

/**
 * O correlationId da requisição: o que o middleware já resolveu (header bem formado ou gerado), para o log, o evento
 * da outbox e o header de resposta serem o mesmo. Fora de uma requisição (chamada direta), cai no header ou no gerado.
 */
export function correlationIdFrom(header: unknown, generate: () => string): string {
  return currentContext()?.correlationId ?? (isValidCorrelationId(header) ? header : generate());
}

/** Parâmetro de rota que precisa ser UUID (walletId, transactionId). */
export function parseUuidParam(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new RequestValidationError([`${name} must be a UUID`]);
  return value.toLowerCase();
}

/** Parâmetro de rota livre do provedor (providerId, externalTransactionId): mesma regra do payload. */
export function parseIdentifierParam(value: unknown, name: string): string {
  const c = new Checker();
  return c.done(c.text(value, name) as string);
}
