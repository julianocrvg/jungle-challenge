/** Campos de erro que podem ir para o log dos workers: nome, nunca a mensagem (texto livre). */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Só as linhas `at ...` do stack. A primeira linha do `stack` repete `Nome: mensagem`, e a mensagem de um erro
 * inesperado é texto livre (um bug, ou o Postgres citando o valor que recusou), então não entra no log.
 */
export function stackFrames(error: unknown): string {
  if (!(error instanceof Error) || error.stack === undefined) return '';
  return error.stack.split('\n').filter((line) => /^\s+at /.test(line)).join('\n');
}
