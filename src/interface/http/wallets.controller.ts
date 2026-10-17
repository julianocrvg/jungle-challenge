import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '../../application/ports/id-generator';
import { CreateWallet } from '../../application/wallets/create-wallet';
import type { MoneyProps } from '../../domain/money';
import { correlationIdFrom, parseCreateWalletRequest } from './validation';

export interface WalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
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
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
