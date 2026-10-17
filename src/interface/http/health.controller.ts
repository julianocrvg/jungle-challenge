import { Controller, Get } from '@nestjs/common';

/** Liveness apenas. Readiness (Postgres e SQS) entra na fatia de observabilidade. */
@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
