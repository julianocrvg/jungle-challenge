import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ID_GENERATOR } from './application/ports/id-generator';
import { BunIdGenerator } from './infrastructure/id/bun-id-generator';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { HealthController } from './interface/http/health.controller';

@Module({
  imports: [MikroOrmModule.forRoot(createOrmConfig())],
  controllers: [HealthController],
  providers: [{ provide: ID_GENERATOR, useClass: BunIdGenerator }],
})
export class AppModule {}
