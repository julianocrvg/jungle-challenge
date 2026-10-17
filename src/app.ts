import 'reflect-metadata';
import type { INestApplication, LoggerService, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppOptions } from './app.module';
import { HttpErrorFilter } from './interface/http/http-error.filter';

export interface CreateAppOptions extends AppOptions {
  logger?: LoggerService | LogLevel[] | false;
}

/** Monta a aplicação com a mesma configuração em produção e nos testes. */
export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const { logger, ...appOptions } = options;
  const app = await NestFactory.create(AppModule.forRoot(appOptions), logger === undefined ? {} : { logger });
  app.useGlobalFilters(new HttpErrorFilter());
  // Fecha o pool do ORM (e, nas próximas fatias, o consumidor SQS) ao receber SIGTERM.
  app.enableShutdownHooks();
  return app;
}
