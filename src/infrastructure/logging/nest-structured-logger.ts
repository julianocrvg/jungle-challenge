import { Logger } from '@nestjs/common';
import type { LogFields, StructuredLogger } from '../../application/ports/structured-logger';

/** Encaminha para o logger do Nest um objeto com a mensagem e os campos; quem formata é o `LoggerService` (JSON). */
export class NestStructuredLogger implements StructuredLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  info(message: string, fields: LogFields = {}): void {
    this.logger.log({ ...fields, message });
  }

  warn(message: string, fields: LogFields = {}): void {
    this.logger.warn({ ...fields, message });
  }

  error(message: string, fields: LogFields = {}): void {
    this.logger.error({ ...fields, message });
  }
}
