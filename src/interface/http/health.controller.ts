import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { NestStructuredLogger } from '../../infrastructure/logging/nest-structured-logger';
import { checkReadiness, READINESS_PROBES, type ProbeStatus, type ReadinessProbe } from './readiness';

interface StatusResponse {
  status(code: number): unknown;
}

/** Sem AuthGuard: health checks ficam abertos (CLAUDE.md, "Autenticação"). */
@Controller('health')
export class HealthController {
  private readonly logger = new NestStructuredLogger('Health');

  constructor(@Inject(READINESS_PROBES) private readonly probeSet: { readonly probes: readonly ReadinessProbe[] }) {}

  /**
   * Liveness: o processo responde. Não toca nenhuma dependência, para o orquestrador não reiniciar a instância
   * só porque o banco caiu (ARCHITECTURE 10.1).
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: Postgres e filas SQS respondem. 503 tira a instância do balanceamento sem matá-la. */
  @Get('ready')
  async ready(
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ status: 'ok' | 'unavailable'; checks: Record<string, ProbeStatus> }> {
    const report = await checkReadiness(this.probeSet.probes);
    if (!report.ready) {
      for (const [probe, error] of Object.entries(report.failures)) {
        this.logger.warn('readiness check failed', { probe, error });
      }
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: report.ready ? 'ok' : 'unavailable', checks: report.checks };
  }
}
