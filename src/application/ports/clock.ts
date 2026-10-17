/** Porta de relógio: o domínio recebe o instante por parâmetro e nunca lê o relógio. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');
