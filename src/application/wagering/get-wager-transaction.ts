import { TransactionNotFoundError } from '../errors';
import type { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work';
import { type WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';

/**
 * Consulta de transação, sem lock (leitura simples dentro de uma transação curta). OPENING é interno e nunca
 * entra nem sai pela API: para quem consulta, ela não existe (ARCHITECTURE 9.3).
 */
export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  byId(transactionId: string): Promise<WagerTransaction> {
    return this.find(
      (repositories) => repositories.transactions.findById(transactionId),
    );
  }

  byProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    return this.find(
      (repositories) => repositories.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
  }

  private async find(
    load: (repositories: TransactionalRepositories) => Promise<WagerTransaction | undefined>,
  ): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.run(load);
    if (transaction === undefined || transaction.kind === WagerTransactionKind.Opening) {
      throw new TransactionNotFoundError('Transaction not found');
    }
    return transaction;
  }
}
