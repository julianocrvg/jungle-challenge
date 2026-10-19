/**
 * Dinheiro do script de carga: SEMPRE bigint em centavos (ou a string decimal da API). Nunca number.
 * O formato é o mesmo da API: string decimal com escala fixa de 2.
 */
const AMOUNT = /^(0|[1-9]\d{0,16})\.(\d{2})$/;

export function centsFromAmount(amount: string): bigint {
  const m = AMOUNT.exec(amount);
  if (m === null) throw new Error(`invalid amount "${amount}"`);
  return BigInt(m[1]!) * 100n + BigInt(m[2]!);
}

export function amountFromCents(cents: bigint): string {
  if (cents < 0n) throw new Error('negative amount');
  const units = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${units}.${frac}`;
}
