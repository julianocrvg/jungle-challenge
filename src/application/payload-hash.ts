import { createHash } from 'node:crypto';

/** Só strings, booleanos, null, listas e objetos: números ficam de fora para que dinheiro nunca vire float. */
export type CanonicalValue = string | boolean | null | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue | undefined };

/** JSON com as chaves ordenadas recursivamente. Chaves com valor `undefined` são omitidas. */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item: CanonicalValue) => canonicalJson(item)).join(',')}]`;
  const object = value as { readonly [key: string]: CanonicalValue | undefined };
  const members = Object.keys(object)
    .sort()
    .flatMap((key) => {
      const member = object[key];
      return member === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
    });
  return `{${members.join(',')}}`;
}

/** SHA-256 hex do JSON canônico (ARCHITECTURE 5.3). */
export function payloadHash(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
