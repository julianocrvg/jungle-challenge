import { Logger } from '@nestjs/common';

/** Um valor monetário (`25.00`), o objeto `money` ou o campo `amount`: nada disso pode aparecer num log. */
export const MONETARY = /\d+\.\d{2}(?!\d)|"money"|"amount"/;

/** Entradas de log que vazariam valores monetários (esperado: nenhuma). */
export function monetaryLeaks(entries: readonly unknown[]): unknown[] {
  return entries.filter((entry) => MONETARY.test(JSON.stringify(entry)));
}

/**
 * Prova que o logger capturado está ligado ao logger estático do Nest: sem isso, o `monetaryLeaks` de um
 * `afterEach` passaria em vazio. Chamado num `beforeAll`, depois de subir a aplicação.
 */
export function assertCaptureWired(logger: { readonly entries: readonly unknown[]; clear(): void }): void {
  new Logger('Canary').log({ message: 'canary', probe: 'capture-wiring-probe' });
  if (!JSON.stringify(logger.entries).includes('capture-wiring-probe')) {
    throw new Error('the capturing logger is not wired to the Nest static logger: log assertions would pass vacuously');
  }
  logger.clear();
}
