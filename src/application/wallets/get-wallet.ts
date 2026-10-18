import { WalletNotFoundError } from '../errors';
import type { WalletQueries, WalletView } from '../ports/wallet-queries';

export class GetWallet {
  constructor(private readonly queries: WalletQueries) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.queries.findWallet(walletId);
    if (wallet === undefined) throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    return wallet;
  }
}
