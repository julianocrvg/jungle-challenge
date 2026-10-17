import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  InvalidCommandError,
  ReferenceNotSupportedYetError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { constraintOf, sqlStateOf } from '../../infrastructure/persistence/database-errors';
import { RequestValidationError } from './validation';

export interface ErrorBody {
  code: string;
  message: string;
  details?: string[];
}

export interface HttpError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
}

/** Retry-After do 503: curto, porque a falha transitória típica (lock, conexão) se resolve em segundos. */
export const RETRY_AFTER_SECONDS = 1;

const HTTP_CODES: Record<number, string> = {
  400: 'INVALID_PAYLOAD',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** Mapeamento único e consistente para todos os endpoints (CLAUDE.md, "Mapeamento HTTP"). */
export function toHttpError(error: unknown): HttpError {
  const of = (status: number, e: { code: string; message: string }, details?: string[]): HttpError => ({
    status,
    body: { code: e.code, message: e.message, ...(details === undefined ? {} : { details }) },
  });

  if (error instanceof RequestValidationError) return of(400, error, error.details);
  if (error instanceof InvalidCommandError) return of(400, error, [error.message]);
  if (error instanceof WalletNotFoundError) return of(404, error);
  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof ExternalTransactionIdConflictError ||
    error instanceof WalletAlreadyExistsError
  ) {
    return of(409, error);
  }
  if (error instanceof ReferenceNotSupportedYetError) return of(501, error);
  if (error instanceof TransientInfrastructureError) {
    return { ...of(503, error), retryAfterSeconds: RETRY_AFTER_SECONDS };
  }
  if (error instanceof HttpException && error.getStatus() < 500) {
    // Erros do próprio Nest/Express: JSON malformado, rota inexistente, corpo grande demais.
    const status = error.getStatus();
    return of(status, { code: HTTP_CODES[status] ?? 'HTTP_ERROR', message: error.message });
  }
  return of(500, { code: 'INTERNAL_ERROR', message: 'Internal error' });
}

interface MinimalResponse {
  status(code: number): MinimalResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const httpError = toHttpError(error);
    this.log(error, httpError);
    if (httpError.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(httpError.retryAfterSeconds));
    }
    response.status(httpError.status).json(httpError.body);
  }

  // Sem payload nem valores financeiros: só o tipo do erro, a mensagem e a constraint/SQLSTATE.
  private log(error: unknown, httpError: HttpError): void {
    if (httpError.status < 500 || httpError.status === 501) return;
    const e = error instanceof Error ? error : new Error(String(error));
    const cause = (e as { cause?: unknown }).cause ?? e;
    const context = JSON.stringify({
      code: httpError.body.code,
      error: e.name,
      message: e.message,
      sqlState: sqlStateOf(cause) ?? null,
      constraint: constraintOf(cause) ?? null,
    });
    if (httpError.status === 503) this.logger.warn(context);
    else this.logger.error(context, e.stack);
  }
}
