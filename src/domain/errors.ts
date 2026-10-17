/** Base dos erros de domínio: violações de invariante, nunca falhas de infraestrutura. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

/** Débito acima do saldo. O use case decide o failureCode (INSUFFICIENT_FUNDS ou REVERSAL_WOULD_OVERDRAW). */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';
}

/** Transição de estado inválida (por exemplo, a partir de um estado terminal). Erro de programação, não de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

/** Dados de uma transação que violam as regras de construção (referência exigida, valor, kind interno...). */
export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = 'INVALID_LEDGER_ENTRY';
}

export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';
}
