import { Logger } from '@nestjs/common';
import type { LogFields, StructuredLogger } from '../../application/ports/structured-logger';
import { contextFields } from './request-context';

/**
 * Encaminha para o logger do Nest um objeto com a mensagem e os campos; quem formata é o `LoggerService` (JSON).
 * Os campos do contexto da requisição/mensagem (`correlationId`, `walletId`...) entram sozinhos; um campo passado
 * explicitamente vence o do contexto.
 */
export class NestStructuredLogger implements StructuredLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  info(message: string, fields: LogFields = {}): void {
    this.logger.log({ ...contextFields(), ...fields, message });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.logger.warn({ ...contextFields(), ...fields, message });
  }

  error(message: string, fields: LogFields = {}): void {
    this.logger.error({ ...contextFields(), ...fields, message });
  }

  /** Nível debug: suprimido pelo `JsonLogger` salvo `LOG_LEVEL=debug` (health e métricas usam este). */
  debug(message: string, fields: LogFields = {}): void {
    this.logger.debug({ ...contextFields(), ...fields, message });
  }
}
