import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ResolvePendingReference } from '../../src/application/wagering/resolve-pending-reference';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload, type WalletBody } from './support/app';

/*
 * Corridas reais (Promise.all contra a API, cada requisição numa conexão própria do pool). Cada cenário roda
 * várias vezes em wallets novas, para que a ordem de chegada ao FOR UPDATE varie entre as rodadas.
 */

const ROUNDS = 10;

let api: TestApp;
let sql: Sql;
let resolver: ResolvePendingReference;
let closeOrm: () => Promise<void>;

beforeAll(async () => {
  const orm = await createTestOrm();
  sql = sqlRunner(orm);
  closeOrm = () => orm.close(true);
  api = await startTestApp();
  resolver = api.app.get(ResolvePendingReference);
});

afterAll(async () => {
  await api?.close();
  await closeOrm?.();
});

// Os logs se acumulariam entre os testes: sem isto, um erro de um teste contaminaria a checagem dos seguintes.
beforeEach(() => api.logger.clear());

const brl = (amount: string) => ({ amount, currency: 'BRL' });

function reversalPayload(w: WalletBody, kind: string, referenceExternalTransactionId: string, amount: string) {
  return wagerPayload(w, { kind, money: brl(amount), referenceExternalTransactionId });
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  return row?.balance as string;
}

async function reversalCreditsOf(betId: string): Promise<number> {
  const [row] = await sql(
    `SELECT count(*)::int AS n FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
     WHERE t.reference_transaction_id = ? AND t.status = 'PROCESSED'`,
    [betId],
  );
  return row?.n as number;
}

/** Nenhum 23505 do índice anti-dupla-reversão (nem qualquer outro erro) chegou ao log. */
function expectNoConstraintErrorsLogged(): void {
  const suspicious = api.logger.entries.filter(
    (e) => e.message.includes('wt_single_reversal_uq') || e.message.includes('23505') || e.message.includes('40P01'),
  );
  expect(suspicious).toEqual([]);
}

describe('double reversal of the same BET in parallel', () => {
  test.each([
    ['REFUND and ROLLBACK', 'REFUND', 'ROLLBACK'],
    ['two REFUNDs with different ids', 'REFUND', 'REFUND'],
  ])('%s: exactly one PROCESSED, the other ALREADY_REVERSED, one credit, zero 5xx', async (_label, first, second) => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = await createWalletViaApi(api, '100.00');
      const betPayload = wagerPayload(w, { money: brl('40.00') });
      const bet = await submit(api, betPayload);
      expect(bet.status).toBe(200);
      const betExternalId = betPayload.externalTransactionId as string;

      const results = await Promise.all([
        submit(api, reversalPayload(w, first, betExternalId, '40.00')),
        submit(api, reversalPayload(w, second, betExternalId, '40.00')),
      ]);

      expect(results.filter((r) => r.status >= 500)).toEqual([]);
      const statuses = results.map((r) => `${r.body.status}:${r.body.failureCode}`).sort();
      expect(statuses).toEqual(['PROCESSED:null', 'REJECTED:ALREADY_REVERSED']);
      expect(await reversalCreditsOf(bet.body.transactionId as string)).toBe(1);
      expect(await balanceOf(w.id)).toBe('100.00');
    }
    expectNoConstraintErrorsLogged();
  });
});

describe('ResolvePendingReference in parallel for the same transaction', () => {
  test('one applies, the other is a no-op, with no error', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const w = await createWalletViaApi(api, '100.00');
      const betExternalId = `ext-${Bun.randomUUIDv7()}`;
      const refund = await submit(api, reversalPayload(w, 'REFUND', betExternalId, '30.00'));
      expect(refund.status).toBe(202);
      const bet = await submit(api, wagerPayload(w, { externalTransactionId: betExternalId, money: brl('30.00') }));
      expect(bet.status).toBe(200);

      const outcomes = await Promise.all([
        resolver.execute(refund.body.transactionId as string),
        resolver.execute(refund.body.transactionId as string),
      ]);
      expect(outcomes.map((o) => o.outcome).sort()).toEqual(['noop', 'resolved']);
      expect(await reversalCreditsOf(bet.body.transactionId as string)).toBe(1);
      expect(await balanceOf(w.id)).toBe('100.00');
    }
    expectNoConstraintErrorsLogged();
  });
});

describe('REFUND and its BET in parallel', () => {
  test('converge: whichever locks the wallet first, after the resolve both are PROCESSED and the balance is back', async () => {
    const orders = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      const w = await createWalletViaApi(api, '100.00');
      const betPayload = wagerPayload(w, { money: brl('25.00') });
      const [bet, refund] = await Promise.all([
        submit(api, betPayload),
        submit(api, reversalPayload(w, 'REFUND', betPayload.externalTransactionId as string, '25.00')),
      ]);
      expect(bet.status).toBe(200);
      expect([200, 202]).toContain(refund.status);
      orders.add(refund.body.status as string);

      if (refund.status === 202) {
        expect((await resolver.execute(refund.body.transactionId as string)).outcome).toBe('resolved');
      }
      const [row] = await sql(`SELECT status FROM wager_transactions WHERE id = ?`, [refund.body.transactionId]);
      expect(row?.status).toBe('PROCESSED');
      expect(await balanceOf(w.id)).toBe('100.00');
    }
    // Não exige que as duas ordens aconteçam (seria não determinístico); só registra o que houve.
    expect([...orders].every((s) => s === 'PROCESSED' || s === 'PENDING_REFERENCE')).toBe(true);
    expectNoConstraintErrorsLogged();
  });
});

describe('invariant', () => {
  test('every wallet balance equals the balance rebuilt from the ledger', async () => {
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });
});
