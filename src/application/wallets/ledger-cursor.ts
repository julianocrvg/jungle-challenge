import { InvalidCursorError } from '../errors';

/*
 * Cursor opaco do ledger: base64url da `wallet_version` do último lançamento da página. A versão é única e
 * monotônica por wallet (ARCHITECTURE 2.5), então a página seguinte é `wallet_version > cursor`.
 */

const MAX_VERSION = 2_147_483_647; // INTEGER do Postgres
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const VERSION = /^[1-9]\d{0,9}$/;

export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(String(walletVersion), 'utf8').toString('base64url');
}

/** Aceita só o que `encodeLedgerCursor` produz: o round-trip exato rejeita padding, prefixos e lixo. */
export function decodeLedgerCursor(cursor: unknown): number {
  const invalid = () => new InvalidCursorError('Invalid cursor');
  if (typeof cursor !== 'string' || !BASE64URL.test(cursor)) throw invalid();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!VERSION.test(decoded)) throw invalid();
  const version = Number(decoded); // inteiro de versão, nunca dinheiro
  if (version > MAX_VERSION || encodeLedgerCursor(version) !== cursor) throw invalid();
  return version;
}
