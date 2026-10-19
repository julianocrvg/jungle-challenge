/** Leitura de /metrics (parser estrito de test/support) e amostragem do lag da outbox. */
import { parsePrometheus } from '../../test/support/prometheus-parser';
import { request, sleep } from './http';
import { aggregateInstances, flatten, type Series } from './stats';

export async function scrape(url: string): Promise<Series[]> {
  const res = await request('GET', url, '/metrics');
  if (res.status !== 200 || typeof res.body !== 'string') throw new Error(`GET ${url}/metrics falhou (status ${res.status})`);
  return flatten(parsePrometheus(res.body));
}

export async function scrapeAll(urls: readonly string[]): Promise<Map<string, Series>> {
  return aggregateInstances(await Promise.all(urls.map(scrape)));
}

/** Amostra outbox_lag_seconds a cada 1 s e guarda o máximo (o gauge é global; max entre instâncias). */
export class LagSampler {
  maxLagSeconds = 0;
  samples = 0;
  private running = true;
  private loop: Promise<void>;

  constructor(private readonly urls: readonly string[]) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const merged = await scrapeAll(this.urls);
        for (const s of merged.values()) {
          if (s.name === 'outbox_lag_seconds') this.maxLagSeconds = Math.max(this.maxLagSeconds, s.value);
        }
        this.samples++;
      } catch {
        /* uma amostra perdida não derruba a carga */
      }
      await sleep(1000);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }
}
