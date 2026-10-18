/** Um valor monetário (`25.00`), o objeto `money` ou o campo `amount`: nada disso pode aparecer num log. */
export const MONETARY = /\d+\.\d{2}(?!\d)|"money"|"amount"/;

/** Entradas de log que vazariam valores monetários (esperado: nenhuma). */
export function monetaryLeaks(entries: readonly unknown[]): unknown[] {
  return entries.filter((entry) => MONETARY.test(JSON.stringify(entry)));
}
