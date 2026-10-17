import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca entra pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  /** Aguardando a transação referenciada chegar (ou terminar). */
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura. Terminal e auditável. */
  Failed = 'FAILED',
}

/** Taxonomia persistida (ARCHITECTURE.md, seção 3). Espelha o CHECK wt_failure_code_valid. */
export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  AlreadyReversed: 'ALREADY_REVERSED',
  AmountMismatch: 'AMOUNT_MISMATCH',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  /** O playerId da transação não é o dono da wallet. */
  PlayerMismatch: 'PLAYER_MISMATCH',
  InternalError: 'INTERNAL_ERROR',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/** Provider reservado à OPENING (ARCHITECTURE 5.6). Nenhum provedor externo pode usá-lo. */
export const INTERNAL_PROVIDER_ID = 'internal';

export function isReservedProviderId(providerId: string): boolean {
  return providerId.toLowerCase() === INTERNAL_PROVIDER_ID;
}

/** Resultado de confrontar uma reversão com a transação que ela referencia. */
export type ReferenceResolution =
  | { outcome: 'resolved' }
  /** Referência ausente ou ainda PENDING_REFERENCE: a dependente fica (ou continua) PENDING_REFERENCE. */
  | { outcome: 'wait' }
  | { outcome: 'reject'; failureCode: FailureCode };

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  /** SHA-256 hex do JSON canônico dos campos de negócio, calculado na camada de aplicação. */
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Saldo observado ao terminar. Presente em PROCESSED e REJECTED (replay devolve a resposta original). */
  balanceAfter?: Money;
  processedAt?: Date;
  attempts: number;
  nextAttemptAt?: Date;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Tipos que cada reversão pode referenciar. */
const REVERSIBLE_KINDS: Record<string, readonly WagerTransactionKind[]> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Transições válidas (PROCESSED, REJECTED e FAILED são terminais):
 *   PENDING           -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 * PENDING_REFERENCE -> PENDING_REFERENCE não é transição: um novo retry é `registerReferenceRetry`.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Id no provedor, não o id interno. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _balanceAfter: Money | undefined,
    private _processedAt: Date | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
  ) {}

  /** Nasce em PENDING. Rejeita OPENING (interno) e valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionError('OPENING is internal and cannot be submitted');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidTransactionError(`Unknown transaction kind`);
    }
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      if (typeof props[field] !== 'string' || props[field].trim() === '') {
        throw new InvalidTransactionError(`${field} is required`);
      }
    }
    if (isReservedProviderId(props.providerId)) {
      throw new InvalidTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    if (!SHA256_HEX.test(props.payloadHash)) {
      throw new InvalidTransactionError('payloadHash must be a SHA-256 hex digest');
    }
    // LOSS registra o resultado sem mover saldo, então aceita zero; todo o resto exige valor positivo.
    if (props.kind === WagerTransactionKind.Loss ? props.money.isNegative() : !props.money.isPositive()) {
      throw new InvalidTransactionError(
        props.kind === WagerTransactionKind.Loss ? 'Amount cannot be negative' : 'Amount must be positive',
      );
    }
    const reference = props.referenceExternalTransactionId;
    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (needsReference && (reference === undefined || reference.trim() === '')) {
      throw new InvalidTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidTransactionError('BET cannot carry a reference');
    }
    return new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey, props.payloadHash,
      props.walletId, props.playerId, props.roundId, props.gameId, props.kind, props.money, reference,
      props.createdAt, WagerTransactionStatus.Pending, undefined, undefined, undefined, undefined, 0, undefined,
    );
  }

  /** Crédito de abertura da wallet, criado só pelo sistema. Sem rodada nem jogo, e nasce em PENDING. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionError('Opening amount must be positive');
    }
    if (!SHA256_HEX.test(props.payloadHash)) {
      throw new InvalidTransactionError('payloadHash must be a SHA-256 hex digest');
    }
    return new WagerTransaction(
      props.id, INTERNAL_PROVIDER_ID, `opening:${props.walletId}`, `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`,
      props.payloadHash,
      props.walletId, props.playerId, undefined, undefined, WagerTransactionKind.Opening, props.money, undefined,
      props.createdAt, WagerTransactionStatus.Pending, undefined, undefined, undefined, undefined, 0, undefined,
    );
  }

  /** Reconstrução a partir da persistência: não revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey, state.payloadHash,
      state.walletId, state.playerId, state.roundId, state.gameId, state.kind, state.money,
      state.referenceExternalTransactionId, state.createdAt, state.status, state.referenceTransactionId,
      state.failureCode, state.balanceAfter, state.processedAt, state.attempts, state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  // ---- transições

  /** `referenceTransactionId` é obrigatório para reversões (o schema exige) e `balanceAfter` é o saldo observado. */
  markProcessed(props: { referenceTransactionId?: string; balanceAfter: Money; at: Date }): void {
    this.assertNotTerminal('process');
    if (this.requiresReference() && props.referenceTransactionId === undefined) {
      throw new InvalidTransactionError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this.assertObservedBalance(props.balanceAfter);
    if (props.balanceAfter.currency !== this.money.currency) {
      throw new InvalidTransactionError('A processed transaction observes a balance in its own currency');
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._balanceAfter = props.balanceAfter;
    this._processedAt = props.at;
    this._nextAttemptAt = undefined;
  }

  /** Só reversões esperam por referência. */
  markPendingReference(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`Cannot move to PENDING_REFERENCE from ${this._status}`);
    }
    if (!this.requiresReference()) {
      throw new InvalidTransactionError(`${this.kind} does not wait for a reference`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
  }

  /** A referência continua ausente: conta a tentativa e agenda a próxima. Não é mudança de status. */
  registerReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`Cannot retry a reference from ${this._status}`);
    }
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt;
  }

  /**
   * Rejeição por regra de negócio: não mexe em saldo, mas guarda o saldo observado para o replay.
   * O saldo está na moeda da wallet, que difere da transação em CURRENCY_MISMATCH (ARCHITECTURE 5.8).
   */
  reject(code: FailureCode, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal('reject');
    if (code === FailureCode.InternalError) {
      throw new InvalidTransactionError('INTERNAL_ERROR is a failure, not a rejection');
    }
    this.assertObservedBalance(balanceAfter);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Erro permanente de infraestrutura (INTERNAL_ERROR). Sem saldo observado. */
  fail(at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = FailureCode.InternalError;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. BET debita; OPENING, WIN e REFUND creditam; ROLLBACK é o inverso da direção
   * da referência. LOSS não tem lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined || !REVERSIBLE_KINDS[WagerTransactionKind.Rollback]?.includes(reference.kind)) {
          throw new InvalidTransactionError('ROLLBACK needs a valid reference to define its direction');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionError('LOSS has no ledger entry');
    }
  }

  /**
   * failureCode quando o débito desta transação deixaria o saldo negativo: aposta sem saldo é
   * INSUFFICIENT_FUNDS; reversão que estoura o saldo é REVERSAL_WOULD_OVERDRAW (situação operacional distinta).
   */
  failureCodeForOverdraw(): FailureCode {
    if (this.kind === WagerTransactionKind.Bet) return FailureCode.InsufficientFunds;
    if (this.requiresReference()) return FailureCode.ReversalWouldOverdraw;
    throw new InvalidTransactionError(`${this.kind} never debits the wallet`);
  }

  /**
   * Confronta esta reversão com a transação referenciada (já carregada por provider + id externo).
   * Ausente ou PENDING_REFERENCE: espera. REJECTED ou FAILED: REFERENCE_NOT_PROCESSED.
   * Não decide ALREADY_REVERSED: depende do banco e é checado pelo use case sob o lock da wallet.
   */
  validateReference(reference: WagerTransaction | undefined): ReferenceResolution {
    if (!this.requiresReference()) {
      throw new InvalidTransactionError(`${this.kind} has no reference to validate`);
    }
    if (reference === undefined) return { outcome: 'wait' };

    const reject = (failureCode: FailureCode): ReferenceResolution => ({ outcome: 'reject', failureCode });

    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (!REVERSIBLE_KINDS[this.kind]?.includes(reference.kind)) {
      return reject(FailureCode.InvalidReferenceKind);
    }
    if (reference.money.currency !== this.money.currency) return reject(FailureCode.CurrencyMismatch);
    if (!reference.money.equals(this.money)) return reject(FailureCode.AmountMismatch);

    switch (reference.status) {
      case WagerTransactionStatus.Processed:
        return { outcome: 'resolved' };
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        return reject(FailureCode.ReferenceNotProcessed);
      default:
        // PENDING e PENDING_REFERENCE: a referência ainda não produziu efeito.
        return { outcome: 'wait' };
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${action} a transaction in terminal state ${this._status}`);
    }
  }

  private assertObservedBalance(balanceAfter: Money): void {
    if (balanceAfter.isNegative()) {
      throw new InvalidTransactionError('balanceAfter must be non-negative');
    }
  }
}
