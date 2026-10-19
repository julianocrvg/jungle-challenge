/** Ambiente da medição, gravado no relatório. Tudo que depende de docker é opcional: falha vira "n/d". */
import os from 'node:os';

const RELEVANT_ENV = [
  'DB_POOL_MAX', 'DB_LOCK_TIMEOUT_MS', 'OUTBOX_PUBLISHER_ENABLED', 'OUTBOX_BATCH_SIZE', 'OUTBOX_POLL_INTERVAL_MS',
  'SQS_CONSUMER_ENABLED', 'SQS_CONSUMER_CONCURRENCY', 'PENDING_REFERENCE_WORKER_ENABLED', 'LOG_LEVEL',
] as const;

async function dockerImages(): Promise<Record<string, string>> {
  try {
    const proc = Bun.spawn(['docker', 'ps', '--format', '{{.Names}}|{{.Image}}'], { stdout: 'pipe', stderr: 'ignore' });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const [name, image] = line.trim().split('|');
      if (name === undefined || image === undefined) continue;
      if (/postgres/i.test(image)) out.postgres = image;
      if (/localstack/i.test(image)) out.localstack = image;
    }
    return out;
  } catch {
    return {};
  }
}

export async function collectEnvironment(urls: readonly string[]): Promise<Record<string, unknown>> {
  const cpus = os.cpus();
  const instanceIds = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(`${url}/health/live`).catch(() => null);
      return res?.headers.get('x-instance-id') ?? 'n/d';
    }),
  );
  const envVars: Record<string, string> = {};
  for (const name of RELEVANT_ENV) {
    const value = process.env[name];
    if (value !== undefined) envVars[name] = value;
  }
  return {
    date: new Date().toISOString(),
    bun: Bun.version,
    os: `${os.platform()} ${os.release()}`,
    cpu: { model: cpus[0]?.model ?? 'n/d', logicalCores: cpus.length },
    totalMemGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    instances: urls.length,
    instanceIds,
    scriptEnvVars: envVars,
    envNote: 'Variáveis lidas do ambiente do SCRIPT; os servidores têm o próprio ambiente (defaults do código quando ausentes).',
    images: await dockerImages(),
  };
}
