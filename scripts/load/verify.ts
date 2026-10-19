/**
 * Verificação de correção sob carga. Qualquer divergência é um ACHADO: o script sai com código diferente de zero.
 * Por wallet: reconciliação do servidor, saldo esperado pelo cliente e ledger (contagens e somas, em bigint).
 */
import { amountFromCents, centsFromAmount } from './cents';
import type { Expectations, LoadWallet } from './engine';
import { mapPool, request } from './http';

interface Money {
  amount: string;
  currency: string;
}

interface LedgerEntry {
  direction: 'CREDIT' | 'DEBIT';
  money: Money;
}

export async function setupWallets(urls: readonly string[], count: number, runId: string, initialCents: bigint): Promise<LoadWallet[]> {
  return mapPool(Array.from({ length: count }), 16, async (_, i) => {
    const playerId = crypto.randomUUID();
    const res = await request('POST', urls[i % urls.length]!, '/wallets', {
      body: { playerId, initialBalance: { amount: amountFromCents(initialCents), currency: 'BRL' } },
    });
    const body = res.body as { id?: string } | null;
    if (res.status !== 201 || typeof body?.id !== 'string') {
      throw new Error(`criação da wallet ${i} falhou (run ${runId}): status ${res.status}`);
    }
    return { id: body.id, playerId, initialCents };
  });
}

async function readLedger(url: string, walletId: string): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor === null ? 'limit=100' : `limit=100&cursor=${cursor}`;
    const res = await request('GET', url, `/wallets/${walletId}/ledger?${query}`);
    if (res.status !== 200) throw new Error(`ledger de ${walletId}: status ${res.status}`);
    const page = res.body as { entries: LedgerEntry[]; nextCursor: string | null };
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return entries;
}

export interface VerifyResult {
  walletsChecked: number;
  ledgerEntriesChecked: number;
  divergences: string[];
}

export async function verifyWallets(urls: readonly string[], wallets: readonly LoadWallet[], expectations: Expectations): Promise<VerifyResult> {
  const divergences: string[] = [];
  let ledgerEntriesChecked = 0;

  await mapPool(wallets, 8, async (wallet, i) => {
    const url = urls[i % urls.length]!;
    const label = `wallet ${wallet.id}`;

    const rec = await request('POST', url, `/wallets/${wallet.id}/reconciliation`);
    const report = rec.body as { consistent?: boolean; difference?: Money } | null;
    if (rec.status !== 200 || report?.consistent !== true) {
      divergences.push(`${label}: reconciliação inconsistente (status ${rec.status}, difference ${report?.difference?.amount ?? 'n/d'})`);
    }

    const got = await request('GET', url, `/wallets/${wallet.id}`);
    const stored = (got.body as { balance?: Money } | null)?.balance?.amount;
    const expectedBalance = amountFromCents(expectations.expectedBalanceCents(wallet));
    if (stored !== expectedBalance) divergences.push(`${label}: saldo ${stored ?? 'n/d'} != esperado pelo cliente ${expectedBalance}`);

    const exp = expectations.stateOf(wallet.id);
    const entries = await readLedger(url, wallet.id);
    ledgerEntriesChecked += entries.length;
    let debitCount = 0;
    let debitCents = 0n;
    let creditCount = 0;
    let creditCents = 0n;
    for (const e of entries) {
      const cents = centsFromAmount(e.money.amount);
      if (e.direction === 'DEBIT') {
        debitCount++;
        debitCents += cents;
      } else {
        creditCount++;
        creditCents += cents;
      }
    }
    if (debitCount !== exp.betsProcessed) divergences.push(`${label}: ${debitCount} débitos no ledger != ${exp.betsProcessed} BETs PROCESSED`);
    if (debitCents !== exp.betCents) divergences.push(`${label}: soma dos débitos ${amountFromCents(debitCents)} != ${amountFromCents(exp.betCents)}`);
    const expectedCredits = (wallet.initialCents > 0n ? 1 : 0) + exp.winsProcessed + exp.refundsProcessed; // OPENING + WIN + REFUND
    if (creditCount !== expectedCredits) divergences.push(`${label}: ${creditCount} créditos no ledger != ${expectedCredits} esperados`);
    const expectedCreditCents = wallet.initialCents + exp.winCents + exp.refundCents;
    if (creditCents !== expectedCreditCents) divergences.push(`${label}: soma dos créditos ${amountFromCents(creditCents)} != ${amountFromCents(expectedCreditCents)}`);
  });

  return { walletsChecked: wallets.length, ledgerEntriesChecked, divergences };
}
