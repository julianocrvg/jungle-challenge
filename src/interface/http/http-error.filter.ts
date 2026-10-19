import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import {
  ExternalTransactionIdConflictError,
  IdempotencyKeyConflictError,
  InvalidCommandError,
  InvalidCursorError,
  InvalidLimitError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { errorFields } from '../../infrastructure/logging/describe-error';
import { NestStructuredLogger } from '../../infrastructure/logging/nest-structured-logger';
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
  if (error instanceof InvalidCursorError || error instanceof InvalidLimitError) return of(400, error);
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) return of(404, error);
  if (
    error instanceof IdempotencyKeyConflictError ||
    error instanceof ExternalTransactionIdConflictError ||
    error instanceof WalletAlreadyExistsError
  ) {
    return of(409, error);
  }
  if (error instanceof TransientInfrastructureError) {
    // Mensagem fixa: a do erro pode carregar texto do driver.
    return { ...of(503, { code: error.code, message: 'Service temporarily unavailable' }), retryAfterSeconds: RETRY_AFTER_SECONDS };
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
  private readonly logger = new NestStructuredLogger('HttpErrorFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const httpError = toHttpError(error);
    this.log(error, httpError);
    if (httpError.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(httpError.retryAfterSeconds));
    }
    response.status(httpError.status).json(httpError.body);
  }

  // Só erros 5xx, e só o que o `errorFields` deixa passar: nome, SQLSTATE, constraint e frames. A mensagem e o stack
  // são texto livre (o Postgres cita o valor recusado) e ficam fora, assim como corpo, headers e chaves de idempotência.
  private log(error: unknown, httpError: HttpError): void {
    if (httpError.status < 500) return;
    const fields = { ...errorFields(error), responseCode: httpError.body.code, status: httpError.status };
    if (httpError.status === 503) this.logger.warn('Request failed with a transient error', fields);
    else this.logger.error('Request failed with an unexpected error', fields);
  }
}
