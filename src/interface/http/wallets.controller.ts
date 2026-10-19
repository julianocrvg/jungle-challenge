import { enrichContext } from '../../infrastructure/logging/request-context';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../application/ports/id-generator';
import { CreateWallet } from '../../application/wallets/create-wallet';
import { GetLedgerPage } from '../../application/wallets/get-ledger-page';
import { GetWallet } from '../../application/wallets/get-wallet';
import { type ReconciliationReport, ReconcileWallet } from '../../application/wallets/reconcile-wallet';
import type { LedgerEntryView } from '../../application/ports/wallet-queries';
import type { MoneyProps } from '../../domain/money';
import { AuthGuard } from './auth.guard';
import { correlationIdFrom, parseCreateWalletRequest, parseUuidParam } from './validation';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerResponse {
  entries: LedgerEntryView[];
  /** `null` na última página. */
  nextCursor: string | null;
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(GetLedgerPage) private readonly getLedgerPage: GetLedgerPage,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlationHeader?: string): Promise<WalletResponse> {
    const request = parseCreateWalletRequest(body);
    const wallet = await this.createWallet.execute({
      ...request,
      correlationId: correlationIdFrom(correlationHeader, () => this.ids.next()),
    });
    enrichContext({ walletId: wallet.id });
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletResponse> {
    const id = parseUuidParam(walletId, 'walletId');
    enrichContext({ walletId: id });
    return this.getWallet.execute(id);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<LedgerResponse> {
    const id = parseUuidParam(walletId, 'walletId');
    enrichContext({ walletId: id });
    return this.getLedgerPage.execute(id, cursor, limit);
  }

  /**
   * POST porque é uma operação (percorre o ledger inteiro, loga e conta divergências), não um recurso.
   * Sempre 200: a divergência é o resultado (consistent: false), não uma falha do pedido.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlationHeader?: string,
  ): Promise<ReconciliationReport> {
    const id = parseUuidParam(walletId, 'walletId');
    enrichContext({ walletId: id });
    return this.reconcileWallet.execute(
      id,
      correlationIdFrom(correlationHeader, () => this.ids.next()),
    );
  }
}
