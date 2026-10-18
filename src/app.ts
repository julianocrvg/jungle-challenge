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
  // SIGTERM: o publisher da outbox conclui o lote em andamento, depois o pool do ORM fecha (ARCHITECTURE 6.5).
  app.enableShutdownHooks();
  return app;
}
