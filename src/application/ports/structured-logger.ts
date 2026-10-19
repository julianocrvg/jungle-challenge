/** Campos de contexto do log. Nunca payload financeiro completo nem dados sensíveis. */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Porta de log estruturado: a camada de aplicação não conhece o logger do Nest. */
export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const STRUCTURED_LOGGER = Symbol('StructuredLogger');

/**
 * Formato aceito para o nome de um erro num log. Única definição: o `describeError` (infraestrutura) e o
 * `PublishOutboxBatch` (aplicação, que não importa a infraestrutura) usam esta mesma regra.
 */
export const SAFE_ERROR_NAME = /^[A-Za-z][\w$]{0,63}$/;
