import { InvalidLimitError, WalletNotFoundError } from '../errors';
import type { LedgerEntryView, WalletQueries } from '../ports/wallet-queries';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';

export interface LedgerSettings {
  defaultPageSize: number;
  maxPageSize: number;
}

export interface LedgerPage {
  entries: LedgerEntryView[];
  /** `null` na última página. */
  nextCursor: string | null;
}

const LIMIT = /^[1-9]\d{0,5}$/;

export class GetLedgerPage {
  constructor(
    private readonly queries: WalletQueries,
    private readonly settings: LedgerSettings,
  ) {}

  /** `cursor` e `limit` chegam crus da query string: a validação (e o 400) é daqui. */
  async execute(walletId: string, cursor: unknown, limit: unknown): Promise<LedgerPage> {
    const afterVersion = cursor === undefined ? 0 : decodeLedgerCursor(cursor);
    const pageSize = this.parseLimit(limit);
    // Uma linha a mais só para saber se existe próxima página, sem COUNT.
    const rows = await this.queries.listLedger(walletId, afterVersion, pageSize + 1);
    if (rows === undefined) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    const entries = rows.slice(0, pageSize);
    const last = entries.at(-1);
    return {
      entries,
      nextCursor: rows.length > pageSize && last !== undefined ? encodeLedgerCursor(last.walletVersion) : null,
    };
  }

  private parseLimit(limit: unknown): number {
    if (limit === undefined) return this.settings.defaultPageSize;
    const max = this.settings.maxPageSize;
    if (typeof limit !== 'string' || !LIMIT.test(limit) || Number(limit) > max) {
      throw new InvalidLimitError(`limit must be an integer between 1 and ${max}`);
    }
    return Number(limit);
  }
}
