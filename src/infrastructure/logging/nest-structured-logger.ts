import { Logger } from '@nestjs/common';
import type { LogFields, StructuredLogger } from '../../application/ports/structured-logger';

/** Encaminha para o logger do Nest com a mensagem e os campos num único JSON. */
export class NestStructuredLogger implements StructuredLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  info(message: string, fields: LogFields = {}): void {
    this.logger.log(JSON.stringify({ message, ...fields }));
  }

  warn(message: string, fields: LogFields = {}): void {
    this.logger.warn(JSON.stringify({ message, ...fields }));
  }

  error(message: string, fields: LogFields = {}): void {
    this.logger.error(JSON.stringify({ message, ...fields }));
  }
}
