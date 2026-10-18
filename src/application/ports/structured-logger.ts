/** Campos de contexto do log. Nunca payload financeiro completo nem dados sensíveis. */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** Porta de log estruturado: a camada de aplicação não conhece o logger do Nest. */
export interface StructuredLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const STRUCTURED_LOGGER = Symbol('StructuredLogger');
