import { type DynamicModule, Module } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { CLOCK, type Clock } from './application/ports/clock';
import { ID_GENERATOR, type IdGenerator } from './application/ports/id-generator';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/unit-of-work';
import { SubmitWagerTransaction } from './application/wagering/submit-wager-transaction';
import { CreateWallet } from './application/wallets/create-wallet';
import { type DatabaseSettings, databaseSettingsFromEnv } from './config';
import { SystemClock } from './infrastructure/clock/system-clock';
import { BunIdGenerator } from './infrastructure/id/bun-id-generator';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { HealthController } from './interface/http/health.controller';
import { WageringTransactionsController } from './interface/http/wagering-transactions.controller';
import { WalletsController } from './interface/http/wallets.controller';

/** Pontos de substituição para testes: banco, gerador de ids e relógio. */
export interface AppOptions {
  database?: Partial<DatabaseSettings>;
  idGenerator?: IdGenerator;
  clock?: Clock;
}

// Os use cases não conhecem o Nest: são montados aqui por factory, sem decorators na camada de aplicação.
@Module({})
export class AppModule {
  static forRoot(options: AppOptions = {}): DynamicModule {
    const database = { ...databaseSettingsFromEnv(), ...options.database };
    const useCaseDeps = [UNIT_OF_WORK, ID_GENERATOR, CLOCK];
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmConfig(database.url, { poolMax: database.poolMax }))],
      controllers: [HealthController, WalletsController, WageringTransactionsController],
      providers: [
        { provide: ID_GENERATOR, useValue: options.idGenerator ?? new BunIdGenerator() },
        { provide: CLOCK, useValue: options.clock ?? new SystemClock() },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm, database.lockTimeoutMs),
          inject: [MikroORM],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new CreateWallet(uow, ids, clock),
          inject: useCaseDeps,
        },
        {
          provide: SubmitWagerTransaction,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) => new SubmitWagerTransaction(uow, ids, clock),
          inject: useCaseDeps,
        },
      ],
    };
  }
}
