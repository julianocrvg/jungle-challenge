import { type Metrics, NOOP_METRICS } from '../../application/ports/metrics';
import { NestStructuredLogger } from '../../infrastructure/logging/nest-structured-logger';
import { isValidCorrelationId, type LogContext, runWithContext } from '../../infrastructure/logging/request-context';

/*
 * Middleware de requisição (ARCHITECTURE 11.3). Abre o contexto de log com o `correlationId` (o `X-Correlation-Id`
 * do cliente, se bem formado; senão um gerado), devolve-o no header e, ao terminar a resposta, registra UMA linha:
 * método, rota (o template, não a URL real), status, duração e os ids preenchidos pelo fluxo. Nunca corpo, query,
 * headers de idempotência nem valores monetários.
 *
 * Adapter: o projeto usa `@nestjs/platform-express`, onde a rota casada fica em `request.route.path` (no Fastify
 * seria `request.routeOptions.url`). `createApp` confere o tipo do adapter, para uma troca de adapter falhar alto
 * em vez de virar `unmatched` em silêncio.
 */

/** Métodos conhecidos; qualquer outro (de um cliente hostil) vira `OTHER`, para não abrir cardinalidade. */
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Health e métricas são chamados o tempo todo pelo orquestrador: nível debug, fora do log por padrão. */
const QUIET_PATHS = /^\/(health(\/|$)|metrics\/?$)/;

export const UNMATCHED_ROUTE = 'unmatched';

/** Cliente que fechou a conexão antes da resposta (convenção do 499 do nginx). */
export const ABORTED_STATUS = '499';

/** O código HTTP como rótulo; fora de 100..599 (não deveria acontecer) vira `unknown`, para não abrir cardinalidade. */
export function statusLabel(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'unknown';
}

interface RequestLike {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Express: preenchido depois que uma rota casa. */
  route?: { path?: unknown };
}

interface ResponseLike {
  statusCode: number;
  writableFinished: boolean;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish' | 'close', listener: () => void): unknown;
}

export function methodLabel(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : 'OTHER';
}

/** O template da rota casada (`/wagering/transactions/:transactionId`); nunca a URL real. */
export function routeTemplate(request: RequestLike): string {
  const path = request.route?.path;
  // O Nest registra um curinga (`/{*all}`) para o 404 de rota inexistente: não é um template de rota de negócio.
  return typeof path === 'string' && path.startsWith('/') && !path.includes('*') ? path : UNMATCHED_ROUTE;
}

export function requestLoggingMiddleware(generateId: () => string, metrics: Metrics = NOOP_METRICS) {
  const logger = new NestStructuredLogger('HttpRequest');

  return (request: RequestLike, response: ResponseLike, next: () => void): void => {
    const header = request.headers['x-correlation-id'];
    const correlationId = isValidCorrelationId(header) ? header : generateId();
    const context: LogContext = { correlationId };
    const started = performance.now();
    response.setHeader('X-Correlation-Id', correlationId);

    let logged = false;
    const log = (aborted: boolean): void => {
      if (logged) return;
      logged = true;
      const elapsedMs = performance.now() - started;
      // Inteiro em milissegundos: um valor com casas decimais pareceria um valor monetário aos testes de vazamento.
      const fields = {
        method: methodLabel(request.method),
        route: routeTemplate(request),
        status: response.statusCode,
        durationMs: Math.round(elapsedMs),
      };
      // Do mesmo ponto da linha de log, uma única vez (a flag `logged` cobre finish + close): conta também 4xx e 5xx,
      // que o filtro de erros não loga, e a requisição abortada (close sem finish). Rótulos limitados (ARCHITECTURE 11.4).
      const labels = { method: fields.method, route: fields.route, status: aborted ? ABORTED_STATUS : statusLabel(fields.status) };
      metrics.increment('http_requests_total', labels);
      metrics.observe('http_request_duration_seconds', elapsedMs / 1000, labels);
      runWithContext(context, () => {
        if (QUIET_PATHS.test(request.path)) logger.debug('http request', fields);
        else if (aborted) logger.warn('http request aborted by the client', fields);
        else if (fields.status >= 500) logger.error('http request', fields);
        else logger.info('http request', fields);
      });
    };
    response.on('finish', () => log(false));
    response.on('close', () => log(!response.writableFinished));

    runWithContext(context, next);
  };
}
