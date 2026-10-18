import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { InMemoryMetrics } from '../../src/infrastructure/metrics/in-memory-metrics';
import {
  createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload, type WalletBody,
} from './support/app';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { monetaryLeaks } from './support/logs';

let api: TestApp;
let sql: Sql;
let closeOrm: () => Promise<void>;
const metrics = new InMemoryMetrics();
const DIVERGENCES = 'reconciliation_divergences_total';

beforeAll(async () => {
  const orm = await createTestOrm();
  sql = sqlRunner(orm);
  closeOrm = () => orm.close(true);
  api = await startTestApp({ metrics });
});

beforeEach(() => api.logger.clear());

afterEach(() => {
  expect(monetaryLeaks(api.logger.entries)).toEqual([]);
});

afterAll(async () => {
  // Invariante final: wallets.balance == saldo reconstruído pelo ledger. Os testes de divergência restauram
  // o saldo que adulteraram (num finally), então vale para todas as wallets do arquivo.
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  await api?.close();
  await closeOrm?.();
});

interface Money { amount: string; currency: string }
interface Report {
  walletId: string; storedBalance: Money; calculatedBalance: Money; difference: Money;
  consistent: boolean; checkedEntries: number;
}

const reconcile = (walletId: string, headers: Record<string, string> = {}) =>
  api.post<Report>(`/wallets/${walletId}/reconciliation`, {}, headers);

const money = (amount: string): Money => ({ amount, currency: 'BRL' });

async function bet(wallet: WalletBody, amount: string, overrides: Record<string, unknown> = {}) {
  const payload = wagerPayload(wallet, { money: money(amount), ...overrides });
  const result = await submit(api, payload);
  return { payload, result };
}

describe('POST /wallets/:walletId/reconciliation', () => {
  test('is consistent after operations, counting the OPENING entry and summing credits minus debits', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    expect((await bet(wallet, '30.00')).result.status).toBe(200); // 70.00
    expect((await bet(wallet, '50.00', { kind: 'WIN' })).result.status).toBe(200); // 120.00
    const second = await bet(wallet, '10.00'); // 110.00
    expect(second.result.status).toBe(200);
    const refund = await bet(wallet, '10.00', {
      kind: 'REFUND', referenceExternalTransactionId: second.payload.externalTransactionId,
    }); // 120.00
    expect(refund.result.status).toBe(200);

    const { status, body } = await reconcile(wallet.id);
    expect(status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id, storedBalance: money('120.00'), calculatedBalance: money('120.00'),
      difference: money('0.00'), consistent: true, checkedEntries: 5, // OPENING, BET, WIN, BET, REFUND
    });
  });

  test('a LOSS has no ledger entry and does not disturb the reconciliation', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    await bet(wallet, '0.00', { kind: 'LOSS' });
    const { body } = await reconcile(wallet.id);
    expect(body.consistent).toBe(true);
    expect(body.checkedEntries).toBe(1);
  });

  test('a wallet without ledger entries: checkedEntries 0, everything 0.00, consistent', async () => {
    const wallet = await createWalletViaApi(api, '0.00');
    const { status, body } = await reconcile(wallet.id);
    expect(status).toBe(200);
    expect(body).toEqual({
      walletId: wallet.id, storedBalance: money('0.00'), calculatedBalance: money('0.00'),
      difference: money('0.00'), consistent: true, checkedEntries: 0,
    });
  });

  test('unknown wallet is a 404 and a malformed id is a 400', async () => {
    const unknown = await api.post<{ code: string }>(`/wallets/${Bun.randomUUIDv7()}/reconciliation`, {});
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('WALLET_NOT_FOUND');
    const malformed = await api.post<{ code: string }>('/wallets/nope/reconciliation', {});
    expect(malformed.status).toBe(400);
  });

  test('a divergence (balance altered by SQL) is reported, logged at error level and counted, but not fixed', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    await bet(wallet, '30.00'); // ledger: +100.00 −30.00 = 70.00
    const before = metrics.counter(DIVERGENCES);

    await sql(`UPDATE wallets SET balance = 75.25 WHERE id = ?`, [wallet.id]);
    try {
      api.logger.clear();
      const { status, body } = await reconcile(wallet.id, { 'x-correlation-id': 'corr-divergence-1' });
      expect(status).toBe(200);
      expect(body).toEqual({
        walletId: wallet.id, storedBalance: money('75.25'), calculatedBalance: money('70.00'),
        difference: money('5.25'), consistent: false, checkedEntries: 2,
      });
      expect(metrics.counter(DIVERGENCES)).toBe(before + 1);

      // O log leva só ids e a diferença: nem saldo guardado, nem calculado, nem payload.
      const errors = api.logger.entries.filter((e) => e.level === 'error');
      expect(errors).toHaveLength(1);
      const logged = JSON.parse(errors[0]!.message) as Record<string, unknown>;
      expect(logged).toEqual({
        message: 'wallet reconciliation divergence', walletId: wallet.id, difference: '5.25', checkedEntries: 2,
        correlationId: 'corr-divergence-1',
      });
      expect(errors[0]!.message).not.toContain('75.25');
      expect(errors[0]!.message).not.toContain('70.00');

      // Não corrige: o saldo adulterado continua lá e a resposta seguinte repete a divergência.
      const [row] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [wallet.id]);
      expect(row?.balance).toBe('75.25');
      expect((await reconcile(wallet.id)).body.consistent).toBe(false);
      expect(metrics.counter(DIVERGENCES)).toBe(before + 2);
    } finally {
      // Restaura o saldo para o invariante balance == ledger do afterAll continuar valendo.
      await sql(`UPDATE wallets SET balance = 70.00 WHERE id = ?`, [wallet.id]);
      // A diferença no log é o único valor monetário que a spec autoriza; o afterEach vigia todo o resto.
      api.logger.clear();
    }
  });

  test('a stored balance below the ledger yields a negative difference, as a decimal string', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    await sql(`UPDATE wallets SET balance = 92.50 WHERE id = ?`, [wallet.id]);
    try {
      const { body } = await reconcile(wallet.id);
      expect(body.consistent).toBe(false);
      expect(body.difference).toEqual(money('-7.50'));
      expect(body.storedBalance).toEqual(money('92.50'));
      expect(body.calculatedBalance).toEqual(money('100.00'));
    } finally {
      await sql(`UPDATE wallets SET balance = 100.00 WHERE id = ?`, [wallet.id]);
      api.logger.clear();
    }
  });

  test('running in parallel with bets never reports a false divergence', async () => {
    const wallet = await createWalletViaApi(api, '1000.00');
    const before = metrics.counter(DIVERGENCES);
    const bets = 90;
    let writing = true;

    const writer = (async () => {
      for (let batch = 0; batch < bets / 6; batch += 1) {
        const results = await Promise.all(Array.from({ length: 6 }, () => bet(wallet, '1.00')));
        for (const { result } of results) expect(result.status).toBe(200);
      }
      writing = false;
    })();

    const reports: Report[] = [];
    while (writing) {
      reports.push(...(await Promise.all(Array.from({ length: 4 }, () => reconcile(wallet.id)))).map((r) => r.body));
    }
    await writer;

    expect(reports.length).toBeGreaterThanOrEqual(8); // o teste só vale se as leituras de fato se sobrepuseram
    const divergent = reports.filter((report) => !report.consistent);
    expect(divergent).toEqual([]);
    expect(metrics.counter(DIVERGENCES)).toBe(before);
    expect(api.logger.entries.filter((e) => e.level === 'error')).toEqual([]);

    // As leituras viram snapshots de pontos diferentes do tempo, todos coerentes entre si.
    const counts = reports.map((report) => report.checkedEntries);
    expect(Math.min(...counts)).toBeLessThan(Math.max(...counts));

    const final = await reconcile(wallet.id);
    expect(final.body).toMatchObject({
      storedBalance: money(`${1000 - bets}.00`), consistent: true, checkedEntries: bets + 1,
    });
  });
});
