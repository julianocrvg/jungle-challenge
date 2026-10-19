/** Cliente HTTP mínimo do script de carga (fetch do Bun). Status null = erro de rede ou timeout. */
export interface HttpResult {
  status: number | null;
  body: unknown;
  ms: number;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 15_000;

export async function request(
  method: 'GET' | 'POST',
  baseUrl: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      /* corpo não-JSON (ex.: /metrics): devolve o texto */
    }
    return { status: response.status, body, ms: performance.now() - started };
  } catch (error) {
    return { status: null, body: null, ms: performance.now() - started, error: error instanceof Error ? error.name : 'error' };
  }
}

/** Executa `fn` sobre os itens com no máximo `limit` em paralelo. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
