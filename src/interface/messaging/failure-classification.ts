import { ApplicationError, TransientInfrastructureError } from '../../application/errors';
import { InvalidMessageError } from './wager-message';

/*
 * Classificação das falhas do consumidor (ARCHITECTURE 7.3). Erro de negócio não chega aqui: uma REJECTED é
 * um resultado persistido e recebe ack como qualquer outro.
 * - permanente: repetir nunca dá certo. Vai direto para a DLQ, para não bloquear o grupo (a wallet) no FIFO.
 * - transitório: repetir mais tarde pode dar certo. Sem ack, volta com backoff até o limite de tentativas.
 * - erro inesperado (bug): transitório com backoff curto, para nunca descartar uma mensagem válida por engano.
 */

export type FailureDisposition =
  | { kind: 'permanent'; reason: string }
  | { kind: 'transient'; reason: string; unexpected: boolean };

export function classifyFailure(error: unknown): FailureDisposition {
  if (error instanceof InvalidMessageError) return { kind: 'permanent', reason: error.reason };
  if (error instanceof TransientInfrastructureError) return { kind: 'transient', reason: error.code, unexpected: false };
  // WALLET_NOT_FOUND, IDEMPOTENCY_KEY_CONFLICT, EXTERNAL_TRANSACTION_ID_CONFLICT, INBOX_MESSAGE_CONFLICT e
  // INVALID_PAYLOAD (regra de construção do domínio): a mesma mensagem falha igual em qualquer tentativa.
  if (error instanceof ApplicationError) return { kind: 'permanent', reason: error.code };
  return { kind: 'transient', reason: 'UNEXPECTED_ERROR', unexpected: true };
}
