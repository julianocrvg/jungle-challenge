import { Body, Controller, Headers, Inject, Post, Res } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../application/ports/id-generator';
import { type SubmissionResult, SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import type { MoneyProps } from '../../domain/money';
import { type FailureCode, WagerTransactionStatus } from '../../domain/wager-transaction';
import { correlationIdFrom, parseIdempotencyKey, parseWagerTransactionPayload } from './validation';

/** Corpo único das respostas de transação, na primeira vez e no replay (ARCHITECTURE 5.9). */
export interface TransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

/** PROCESSED: 200. REJECTED: 422, com failureCode. O replay repete o status da resposta original. */
export function statusCodeFor(status: WagerTransactionStatus): number {
  return status === WagerTransactionStatus.Rejected ? 422 : 200;
}

export function toTransactionResponse({ transaction, idempotentReplay }: SubmissionResult): TransactionResponse {
  const balance = transaction.balanceAfter;
  if (balance === undefined) throw new Error(`Transaction ${transaction.id} has no observed balance`);
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: balance.toJSON(),
    idempotentReplay,
  };
}

interface StatusResponse {
  status(code: number): unknown;
}

@Controller('wagering/transactions')
export class WageringTransactionsController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submitTransaction: SubmitWagerTransaction,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<TransactionResponse> {
    const idempotencyKey = parseIdempotencyKey(idempotencyKeyHeader);
    const payload = parseWagerTransactionPayload(body);
    const result = await this.submitTransaction.execute({
      idempotencyKey,
      payload,
      correlationId: correlationIdFrom(correlationHeader, () => this.ids.next()),
    });
    response.status(statusCodeFor(result.transaction.status));
    return toTransactionResponse(result);
  }
}
