import { describe, expect, test } from 'bun:test';

/*
 * Auditoria das métricas em `src/` (ARCHITECTURE 11.4): nomes válidos e coerentes com o tipo, nenhum id de negócio
 * como label (cardinalidade) e a lista mínima do enunciado coberta. Um varredor de texto, como o dos logs.
 */

const CALL = /\.(increment|gauge|observe)\(\s*'([^']+)'([^;]*?)\);/gs;
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const FORBIDDEN_LABELS = /\b(providerId|walletId|transactionId|messageId|externalTransactionId|playerId|idempotencyKey|provider_id|wallet_id|transaction_id|message_id|player_id)\b/;

interface Use { file: string; kind: string; name: string; rest: string }

const posix = (path: string): string => path.split(String.fromCharCode(92)).join('/');

async function uses(): Promise<Use[]> {
  const found: Use[] = [];
  for await (const path of new Bun.Glob('src/**/*.ts').scan('.')) {
    const source = await Bun.file(path).text();
    for (const match of source.matchAll(CALL)) found.push({ file: path, kind: match[1]!, name: match[2]!, rest: match[3]! });
  }
  return found;
}

describe('métricas em src/', () => {
  test('nomes válidos, contadores terminam em _total e histogramas em _seconds', async () => {
    const all = await uses();
    expect(all.length).toBeGreaterThan(30); // o varredor enxerga as chamadas
    for (const use of all) {
      expect(NAME.test(use.name)).toBe(true);
      if (use.kind === 'increment') expect(use.name.endsWith('_total')).toBe(true);
      if (use.kind === 'observe') expect(use.name.endsWith('_seconds')).toBe(true);
      if (use.kind === 'gauge') expect(use.name.endsWith('_total')).toBe(false);
    }
  });

  test('o mesmo nome nunca é usado com dois tipos', async () => {
    const kinds = new Map<string, Set<string>>();
    for (const use of await uses()) kinds.set(use.name, (kinds.get(use.name) ?? new Set()).add(use.kind));
    expect([...kinds].filter(([, set]) => set.size > 1).map(([name]) => name)).toEqual([]);
  });

  test('providerId, walletId, transactionId e afins nunca são label', async () => {
    const bad = (await uses()).filter((use) => FORBIDDEN_LABELS.test(use.rest)).map((use) => `${use.file}: ${use.name}`);
    expect(bad).toEqual([]);
  });

  test('a lista mínima do enunciado está coberta', async () => {
    const names = new Set((await uses()).map((use) => use.name));
    const required: Record<string, string> = {
      'transações por status': 'wager_transactions_total',
      'duplicatas detectadas': 'wager_duplicates_total',
      'conflito de idempotência (409)': 'wager_idempotency_conflicts_total',
      'conflitos de lock': 'db_lock_conflicts_total',
      'retries (outbox)': 'outbox_retries_total',
      'retries (consumidor)': 'sqs_consumer_retries_total',
      'retries (pendentes)': 'pending_reference_retries_total',
      'mensagens movidas para a DLQ': 'sqs_consumer_dlq_total',
      'lag da outbox': 'outbox_lag_seconds',
      'latência HTTP (contagem por status)': 'http_requests_total',
      'latência HTTP (histograma)': 'http_request_duration_seconds',
      'latência do consumidor': 'sqs_consumer_processing_seconds',
    };
    expect(Object.entries(required).filter(([, name]) => !names.has(name)).map(([what]) => what)).toEqual([]);
  });

  test('o contador antigo de duplicatas do consumidor não existe mais (migrado para wager_duplicates_total)', async () => {
    expect([...(await uses())].some((use) => use.name === 'sqs_consumer_duplicates_total')).toBe(false);
  });
});

describe('pontos únicos de contagem', () => {
  test('db_lock_conflicts_total só é incrementada no UnitOfWork (HTTP, consumidor e workers não contam de novo)', async () => {
    const files = new Set((await uses()).filter((use) => use.name === 'db_lock_conflicts_total').map((use) => posix(use.file)));
    expect([...files]).toEqual(['src/infrastructure/persistence/mikro-orm-unit-of-work.ts']);
  });

  test('wager_transactions_total e wager_duplicates_total só saem dos use cases, depois do commit', async () => {
    for (const name of ['wager_transactions_total', 'wager_duplicates_total', 'wager_idempotency_conflicts_total']) {
      const files = new Set((await uses()).filter((use) => use.name === name).map((use) => posix(use.file)));
      expect([...files].every((file) => file.startsWith('src/application/wagering/'))).toBe(true);
    }
  });

  test('as métricas HTTP saem de um único ponto, o middleware da linha de requisição', async () => {
    for (const name of ['http_requests_total', 'http_request_duration_seconds']) {
      const files = new Set((await uses()).filter((use) => use.name === name).map((use) => posix(use.file)));
      expect([...files]).toEqual(['src/interface/http/request-logging.middleware.ts']);
    }
  });
});
