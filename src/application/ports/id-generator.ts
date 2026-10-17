/** Porta para geração de ids. Domínio e aplicação não sabem de onde vem o UUID. */
export interface IdGenerator {
  /** UUIDv7: ordenável por tempo, bom para índices B-tree em inserts concorrentes. */
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
