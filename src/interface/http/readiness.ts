/** Uma dependência sem a qual a instância não deve receber tráfego (ARCHITECTURE 10.1). */
export interface ReadinessProbe {
  readonly name: string;
  /** Resolve se a dependência respondeu; rejeita caso contrário. O sinal aborta quando o teto do check vence. */
  check(signal: AbortSignal): Promise<void>;
}

export const READINESS_PROBES = Symbol('READINESS_PROBES');

/** Teto de cada check: um load balancer não pode ficar pendurado num banco que aceita a conexão e não responde. */
export const READINESS_TIMEOUT_MS = 2_000;

export type ProbeStatus = 'ok' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, ProbeStatus>;
  /** Só o nome do erro de cada probe que falhou (nunca a mensagem, que é texto livre). */
  failures: Record<string, string>;
}

/**
 * Roda todos os probes em paralelo, cada um com o próprio teto. O teto é aplicado aqui com `Promise.race`, então
 * vale mesmo para um adaptador que ignore o sinal (o driver do Postgres não aceita AbortSignal).
 */
export async function checkReadiness(probes: readonly ReadinessProbe[], timeoutMs = READINESS_TIMEOUT_MS): Promise<ReadinessReport> {
  const results = await Promise.all(probes.map(async (probe) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReadinessTimeoutError());
      }, timeoutMs);
    });
    try {
      await Promise.race([probe.check(controller.signal), timeout]);
      return { name: probe.name, failure: undefined };
    } catch (error) {
      return { name: probe.name, failure: error instanceof Error ? error.name : 'UnknownError' };
    } finally {
      clearTimeout(timer);
    }
  }));
  const checks: Record<string, ProbeStatus> = {};
  const failures: Record<string, string> = {};
  for (const { name, failure } of results) {
    checks[name] = failure === undefined ? 'ok' : 'down';
    if (failure !== undefined) failures[name] = failure;
  }
  return { ready: Object.keys(failures).length === 0, checks, failures };
}

export class ReadinessTimeoutError extends Error {
  override readonly name = 'ReadinessTimeoutError';

  constructor() {
    super('Readiness check timed out');
  }
}
