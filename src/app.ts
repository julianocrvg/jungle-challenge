import 'reflect-metadata';
import type { INestApplication, LoggerService, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppOptions } from './app.module';
import { instanceIdFromEnv } from './config';
import { JsonLogger } from './infrastructure/logging/json-logger';
import { HttpErrorFilter } from './interface/http/http-error.filter';

export interface CreateAppOptions extends AppOptions {
  logger?: LoggerService | LogLevel[] | false;
}

interface HeaderResponse {
  setHeader(name: string, value: string): unknown;
}

/** Monta a aplicação com a mesma configuração em produção e nos testes. */
export async function createApp(options: CreateAppOptions = {}): Promise<INestApplication> {
  const { logger, ...appOptions } = options;
  const instanceId = appOptions.instanceId ?? instanceIdFromEnv();
  const app = await NestFactory.create(AppModule.forRoot({ ...appOptions, instanceId }), { logger: logger ?? new JsonLogger() });
  // Toda resposta diz qual instância a atendeu, inclusive as de erro (ARCHITECTURE 10.2).
  app.use((_request: unknown, response: HeaderResponse, next: () => void) => {
    response.setHeader('X-Instance-Id', instanceId);
    next();
  });
  app.useGlobalFilters(new HttpErrorFilter());
  // SIGTERM: o publisher da outbox conclui o lote em andamento, depois o pool do ORM fecha (ARCHITECTURE 6.5).
  app.enableShutdownHooks();
  return app;
}
