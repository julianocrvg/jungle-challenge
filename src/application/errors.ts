/**
 * Erros que os use cases devolvem a quem chama (HTTP ou fila). Cada um tem um `code` estável e legível
 * por máquina; o mapeamento para status HTTP fica na camada de interface.
 */
/** Conjunto fechado: o `code` vai para respostas, métricas e para o motivo da DLQ, então nunca é texto livre. */
export type ApplicationErrorCode =
  | 'INVALID_PAYLOAD' | 'WALLET_NOT_FOUND' | 'WALLET_ALREADY_EXISTS' | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'EXTERNAL_TRANSACTION_ID_CONFLICT' | 'INBOX_MESSAGE_CONFLICT' | 'SERVICE_UNAVAILABLE' | 'TRANSACTION_NOT_FOUND'
  | 'INVALID_CURSOR' | 'INVALID_LIMIT';

export abstract class ApplicationError extends Error {
  abstract readonly code: ApplicationErrorCode;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** O comando viola uma regra de construção do domínio (equivale a payload inválido). */
export class InvalidCommandError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

/** Mesma Idempotency-Key com payload diferente: conflito, não replay. */
export class IdempotencyKeyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
}

/** Mesmo (providerId, externalTransactionId) chegou com outra Idempotency-Key. */
export class ExternalTransactionIdConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';
}

/** Mesmo messageId (no mesmo consumidor) com conteúdo diferente: não é redelivery (ARCHITECTURE 7.2). */
export class InboxMessageConflictError extends ApplicationError {
  readonly code = 'INBOX_MESSAGE_CONFLICT';
}

/** Banco indisponível, timeout de lock, deadlock, falha de serialização: pode ser reenviado com segurança. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE';
}

/** Transação inexistente numa consulta (nada é persistido por uma consulta). */
export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

/** Cursor do ledger que não é um dos que a API emite (ARCHITECTURE 9.2). */
export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';
}

/** `limit` do ledger fora de 1..máximo configurado. */
export class InvalidLimitError extends ApplicationError {
  readonly code = 'INVALID_LIMIT';
}
