import type { IdGenerator } from '../../application/ports/id-generator';

/** Usa o UUIDv7 nativo do Bun, sem dependência extra. */
export class BunIdGenerator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
