/*
 * Varredura de uma linha de log de um processo filho (multi-instance, ARCHITECTURE 10.2). O JsonLogger escreve uma
 * linha JSON por entrada; só os campos de texto de linhas de nível de falha são examinados, para um nome de campo
 * ou uma chave não acusar por engano. O que não é JSON (crash dump do runtime, linha cortada) segue a regra
 * antiga: o padrão proibido é procurado na linha inteira.
 */

export const MAX_SCAN_DEPTH = 10;
/** Níveis em que `errorFields` pode escrever SQLSTATE e nome de constraint (`fatal` entra por precaução). */
const FAILURE_LEVELS = new Set(['error', 'warn', 'fatal']);
const KNOWN_LEVELS = new Set([...FAILURE_LEVELS, 'info', 'debug', 'verbose']);

/** `true` se algum valor string, em qualquer profundidade até o limite, casa com um padrão. Passar do limite conta como achado. */
function stringValueMatches(value: unknown, patterns: readonly RegExp[], depth: number): boolean {
  if (typeof value === 'string') return patterns.some((pattern) => pattern.test(value));
  if (typeof value !== 'object' || value === null) return false;
  if (depth >= MAX_SCAN_DEPTH) return true;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => stringValueMatches(child, patterns, depth + 1));
}

/** `true` se a linha contém um valor proibido. */
export function scanLogLine(line: string, patterns: readonly RegExp[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return patterns.some((pattern) => pattern.test(line));
  }
  const level = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { level?: unknown }).level : undefined;
  if (typeof level !== 'string' || !KNOWN_LEVELS.has(level)) return patterns.some((pattern) => pattern.test(line));
  if (!FAILURE_LEVELS.has(level)) return false;
  return stringValueMatches(parsed, patterns, 0);
}
