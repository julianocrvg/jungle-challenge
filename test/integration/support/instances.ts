import type { Subprocess } from 'bun';
import { ChildOutput, type QueuePair } from './consumer';
import { TEST_DATABASE_URL } from './database';

/*
 * Instâncias reais da aplicação (`bun src/main.ts`) para os testes multi-instância (ARCHITECTURE 10.2).
 * Cada filho tem porta, INSTANCE_ID e application_name (PGAPPNAME) próprios, e o mesmo Postgres e LocalStack.
 */

/** Configuração comum dos filhos. Pool: 5 (consumidor) + 1 (publisher) + 4 (pendentes) = 10 = 15 - 5 (8.5). */
export const CHILD_POOL_MAX = 15;
/** Visibilidade 12 s > orçamento de 3 s (lock) + 5 s (margem): sobram 4 s para começar cada mensagem (7.4). */
const CHILD_ENV = {
  DB_POOL_MAX: String(CHILD_POOL_MAX),
  DB_LOCK_TIMEOUT_MS: '3000',
  SQS_CONSUMER_CONCURRENCY: '5',
  SQS_CONSUMER_WAIT_SECONDS: '1',
  SQS_CONSUMER_VISIBILITY_TIMEOUT_S: '12',
  SQS_CONSUMER_MAX_ATTEMPTS: '5',
  SQS_CONSUMER_BACKOFF_BASE_MS: '500',
  SQS_CONSUMER_BACKOFF_MAX_MS: '2000',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_CONCURRENCY: '4',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_BACKOFF_BASE_MS: '100',
  PENDING_REFERENCE_BACKOFF_MAX_MS: '500',
  NO_COLOR: '1',
};
/** O redrive da fila temporária precisa ser >= 3 x SQS_CONSUMER_MAX_ATTEMPTS, senão o consumidor não sobe. */
export const CHILD_REDRIVE_MAX_RECEIVE = 15;

export interface InstanceQueues extends QueuePair {
  eventsUrl: string;
}

export class Instance {
  /** Requisições HTTP do pai ainda sem resposta para esta instância: sinal de trabalho em voo antes do kill. */
  pending = 0;
  killed = false;

  constructor(
    readonly id: string,
    readonly port: number,
    readonly child: Subprocess,
    readonly stdout: ChildOutput,
    readonly stderr: ChildOutput,
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** O nome da sessão no pg_stat_activity (PGAPPNAME). */
  get applicationName(): string {
    return this.id;
  }

  lines(): string[] {
    return [...this.stdout.lines, ...this.stderr.lines];
  }

  /**
   * Crash: no Windows o `kill()` do Bun termina o processo à força (TerminateProcess, sem SIGTERM entregue), e
   * no Linux mandamos SIGKILL explicitamente. Nenhum hook de shutdown roda (ARCHITECTURE 10.2).
   */
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    this.child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    await this.child.exited;
  }
}

const all: Instance[] = [];
let exitHandlerInstalled = false;

/** Mata todos os filhos ainda vivos. Síncrono, para servir também no `process.on('exit')`. */
export function killAllInstancesSync(): void {
  for (const instance of all) {
    if (instance.killed) continue;
    instance.killed = true;
    try {
      instance.child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    } catch {
      // já morto
    }
  }
}

function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

/**
 * Sobe uma instância e espera o `/health/ready` dela, com prazo. A porta livre é escolhida antes do spawn, então
 * outro processo pode tomá-la nesse intervalo: se o filho morrer com EADDRINUSE, tenta de novo com outra porta.
 */
export async function spawnInstance(id: string, queues: InstanceQueues, timeoutMs = 30_000): Promise<Instance> {
  if (!exitHandlerInstalled) {
    process.on('exit', killAllInstancesSync);
    exitHandlerInstalled = true;
  }
  const maxTries = 3;
  for (let attempt = 1; ; attempt++) {
    const port = freePort();
    const child = Bun.spawn([process.execPath, 'src/main.ts'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ...CHILD_ENV,
        PORT: String(port),
        INSTANCE_ID: id,
        PGAPPNAME: id,
        DATABASE_URL: TEST_DATABASE_URL,
        SQS_EVENTS_QUEUE_URL: queues.eventsUrl,
        SQS_TRANSACTIONS_QUEUE_URL: queues.queueUrl,
        SQS_TRANSACTIONS_DLQ_URL: queues.dlqUrl,
      },
    });
    const instance = new Instance(id, port, child, new ChildOutput(child.stdout), new ChildOutput(child.stderr));
    all.push(instance);
    const ready = await waitReady(instance, timeoutMs);
    if (ready) return instance;
    instance.killed = true;
    const portTaken = instance.lines().some((line) => line.includes('EADDRINUSE'));
    if (!portTaken || attempt >= maxTries) {
      throw new Error(`instance ${id} never became ready (attempt ${attempt}); output:\n${instance.lines().join('\n')}`);
    }
  }
}

/** Polling no /health/ready até 200. Falso se o filho morreu antes (porta ocupada, erro de boot). */
export async function waitReady(instance: Instance, timeoutMs: number): Promise<boolean> {
  let exited = false;
  void instance.child.exited.then(() => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) return false;
    try {
      const response = await fetch(`${instance.baseUrl}/health/ready`, { signal: AbortSignal.timeout(3_000), keepalive: false });
      if (response.status === 200) return true;
    } catch {
      // ainda não escuta
    }
    await Bun.sleep(100);
  }
  instance.child.kill();
  await instance.child.exited;
  throw new Error(`instance ${instance.id} not ready within ${timeoutMs} ms; output:\n${instance.lines().join('\n')}`);
}
