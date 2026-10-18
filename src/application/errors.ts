/**
 * Erros que os use cases devolvem a quem chama (HTTP ou fila). Cada um tem um `code` estável e legível
 * por máquina; o mapeamento para status HTTP fica na camada de interface.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

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
