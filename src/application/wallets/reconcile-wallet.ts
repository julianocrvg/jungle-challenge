import type { MoneyProps } from '../../domain/money';
import { WalletNotFoundError } from '../errors';
import type { Metrics } from '../ports/metrics';
import type { StructuredLogger } from '../ports/structured-logger';
import type { WalletQueries } from '../ports/wallet-queries';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export const RECONCILIATION_DIVERGENCES_TOTAL = 'reconciliation_divergences_total';

/**
 * Confere `wallets.balance` contra a soma do ledger (créditos − débitos, OPENING incluído). Só observa: uma
 * divergência vira log `error`, contador e `consistent: false`, nunca correção (o ledger é imutável e a
 * correção seria decisão humana). Soma o ledger inteiro a cada chamada (ARCHITECTURE 9.4).
 */
export class ReconcileWallet {
  constructor(
    private readonly queries: WalletQueries,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const snapshot = await this.queries.reconcile(walletId);
    if (snapshot === undefined) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    if (!snapshot.consistent) {
      this.metrics.increment(RECONCILIATION_DIVERGENCES_TOTAL);
      // Só ids e a diferença: nem saldo guardado, nem saldo calculado, nem payload de transação.
      this.logger.error('wallet reconciliation divergence', {
        walletId,
        difference: snapshot.difference.amount,
        checkedEntries: snapshot.checkedEntries,
        correlationId,
      });
    }
    return { walletId, ...snapshot };
  }
}
