import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';

let orm: MikroORM;
let sql: Sql;

const uuid = () => Bun.randomUUIDv7();

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
});

afterAll(async () => {
  await orm?.close(true);
});

/** Executa o SQL e exige que o Postgres o recuse citando a constraint (ou a mensagem) esperada. */
async function expectRejected(statement: string, params: unknown[], expected: string): Promise<void> {
  let error: unknown;
  try {
    await sql(statement, params);
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  const err = error as { constraint?: string; message?: string };
  expect(`${err.constraint ?? ''} ${err.message ?? ''}`).toContain(expected);
}

interface WalletFixture {
  walletId: string;
  playerId: string;
  openingTxId: string | null;
}

/** Cria wallet com saldo inicial coerente: transação OPENING e lançamento CREDIT quando > 0. */
async function createWallet(balance = '100.00', currency = 'BRL'): Promise<WalletFixture> {
  const walletId = uuid();
  const playerId = uuid();
  await sql(`INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, ?, ?)`, [
    walletId, playerId, currency, balance,
  ]);
  if (balance === '0.00') return { walletId, playerId, openingTxId: null };

  const openingTxId = uuid();
  await sql(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        kind, amount, currency, status, balance_after, processed_at)
     VALUES (?, 'internal', ?, ?, ?, ?, ?, 'OPENING', ?, ?, 'PROCESSED', ?, now())`,
    [openingTxId, `opening:${walletId}`, `internal:opening:${walletId}`, 'a'.repeat(64), walletId, playerId,
      balance, currency, balance],
  );
  await sql(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
     VALUES (?, ?, ?, 1, 'CREDIT', ?, ?, '0.00', ?)`,
    [uuid(), walletId, openingTxId, balance, currency, balance],
  );
  return { walletId, playerId, openingTxId };
}

interface TxOverrides {
  id?: string;
  providerId?: string;
  externalId?: string;
  idempotencyKey?: string;
  kind?: string;
  amount?: string;
  currency?: string;
  status?: string;
  failureCode?: string | null;
  balanceAfter?: string | null;
  referenceExternalId?: string | null;
  referenceTxId?: string | null;
  processedAt?: 'now' | null;
}

/** Monta um INSERT de wager_transaction válido por padrão (BET PROCESSED), sobrescrevendo campos. */
function txInsert(wallet: WalletFixture, o: TxOverrides = {}): [string, unknown[]] {
  const externalId = o.externalId ?? `ext-${uuid()}`;
  const providerId = o.providerId ?? 'provider-a';
  const status = o.status ?? 'PROCESSED';
  const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(status);
  const processedAt = o.processedAt === undefined ? (terminal ? 'now' : null) : o.processedAt;
  return [
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
        status, failure_code, balance_after, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'round-1', 'fortune-chimp', ?, ?, ?, ?, ?, ?, ?, ?, ${
       processedAt === 'now' ? 'now()' : 'NULL'
     })`,
    [
      o.id ?? uuid(), providerId, externalId, o.idempotencyKey ?? `${providerId}:${externalId}`, 'b'.repeat(64),
      wallet.walletId, wallet.playerId, o.kind ?? 'BET', o.amount ?? '10.00', o.currency ?? 'BRL',
      o.referenceExternalId ?? null, o.referenceTxId ?? null, status, o.failureCode ?? null,
      o.balanceAfter === undefined ? (status === 'PROCESSED' || status === 'REJECTED' ? '90.00' : null) : o.balanceAfter,
    ],
  ];
}

async function insertTx(wallet: WalletFixture, o: TxOverrides = {}): Promise<void> {
  const [statement, params] = txInsert(wallet, o);
  await sql(statement, params);
}

async function expectTxRejected(wallet: WalletFixture, o: TxOverrides, expected: string): Promise<void> {
  const [statement, params] = txInsert(wallet, o);
  await expectRejected(statement, params, expected);
}

function ledgerInsert(
  walletId: string, txId: string, version: number, direction: string, amount: string,
  before: string, after: string, currency = 'BRL',
): [string, unknown[]] {
  return [
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), walletId, txId, version, direction, amount, currency, before, after],
  ];
}

describe('wallets', () => {
  test('rejects a second wallet for the same player and currency', async () => {
    const w = await createWallet('0.00');
    await expectRejected(
      `INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, 'BRL', '0.00')`,
      [uuid(), w.playerId], 'wallets_player_currency_uq',
    );
  });

  test('allows the same player in a different currency', async () => {
    const w = await createWallet('0.00');
    await sql(`INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, 'USD', '0.00')`, [
      uuid(), w.playerId,
    ]);
  });

  test('rejects a negative balance, on insert and on update', async () => {
    await expectRejected(
      `INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, 'BRL', '-0.01')`,
      [uuid(), uuid()], 'wallets_balance_non_negative',
    );
    const w = await createWallet('0.00');
    await expectRejected(`UPDATE wallets SET balance = balance - 0.01 WHERE id = ?`, [w.walletId],
      'wallets_balance_non_negative');
  });

  test('rejects an invalid currency code', async () => {
    await expectRejected(
      `INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, 'brl', '0.00')`,
      [uuid(), uuid()], 'wallets_currency_format',
    );
  });

  test('version starts at 1', async () => {
    const w = await createWallet('0.00');
    const [row] = await sql(`SELECT version FROM wallets WHERE id = ?`, [w.walletId]);
    expect(row?.version).toBe(1);
  });
});

describe('wager_transactions', () => {
  test('idempotency key is unique', async () => {
    const w = await createWallet();
    await insertTx(w, { idempotencyKey: 'key-dup' });
    await expectTxRejected(w, { idempotencyKey: 'key-dup' }, 'wt_idempotency_key_uq');
  });

  test('(provider_id, external_transaction_id) is unique', async () => {
    const w = await createWallet();
    await insertTx(w, { externalId: 'ext-dup', idempotencyKey: 'k1' });
    await expectTxRejected(w, { externalId: 'ext-dup', idempotencyKey: 'k2' }, 'wt_provider_external_uq');
  });

  test('ON CONFLICT (idempotency_key) DO NOTHING inserts nothing on duplicate', async () => {
    const w = await createWallet();
    await insertTx(w, { idempotencyKey: 'key-on-conflict' });
    const [statement, params] = txInsert(w, { idempotencyKey: 'key-on-conflict' });
    const rows = await sql(`${statement} ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, params);
    expect(rows).toHaveLength(0);
  });

  test('REFUND and ROLLBACK require a reference', async () => {
    const w = await createWallet();
    await expectTxRejected(w, { kind: 'REFUND', status: 'PENDING' }, 'wt_reference_by_kind');
    await expectTxRejected(w, { kind: 'ROLLBACK', status: 'PENDING' }, 'wt_reference_by_kind');
  });

  test('BET and OPENING cannot carry a reference', async () => {
    const w = await createWallet();
    await expectTxRejected(w, { kind: 'BET', referenceExternalId: 'x' }, 'wt_reference_by_kind');
  });

  test('WIN may optionally reference the BET', async () => {
    const w = await createWallet();
    await insertTx(w, { kind: 'WIN', referenceExternalId: 'bet-1' });
    await insertTx(w, { kind: 'WIN' });
  });

  test('amount must be positive, zero only for LOSS', async () => {
    const w = await createWallet();
    await expectTxRejected(w, { kind: 'BET', amount: '0.00' }, 'wt_amount_valid');
    await expectTxRejected(w, { kind: 'WIN', amount: '-1.00' }, 'wt_amount_valid');
    await expectTxRejected(w, { kind: 'LOSS', amount: '-1.00' }, 'wt_amount_valid');
    await insertTx(w, { kind: 'LOSS', amount: '0.00' });
  });

  test('rejects unknown kind, status and failure code', async () => {
    const w = await createWallet();
    await expectTxRejected(w, { kind: 'JACKPOT' }, 'wt_kind_valid');
    await expectTxRejected(w, { status: 'DONE' }, 'wt_status_valid');
    await expectTxRejected(w, { status: 'REJECTED', failureCode: 'NOPE' }, 'wt_failure_code_valid');
  });

  test('failure_code is present exactly on REJECTED and FAILED', async () => {
    const w = await createWallet();
    await expectTxRejected(w, { status: 'REJECTED', failureCode: null }, 'wt_failure_code_status');
    await expectTxRejected(w, { status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' }, 'wt_failure_code_status');
    await insertTx(w, { status: 'FAILED', failureCode: 'INTERNAL_ERROR' });
    await insertTx(w, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('terminal states require processed_at, non-terminal forbid it', async () => {
    const w = await createWallet();
    await expectTxRejected(w, { status: 'PROCESSED', processedAt: null }, 'wt_terminal_processed_at');
    await expectTxRejected(w, { status: 'PENDING', processedAt: 'now' }, 'wt_terminal_processed_at');
  });

  test('PROCESSED and REJECTED keep the observed balance for replay', async () => {
    const w = await createWallet();
    await expectTxRejected(w, { status: 'PROCESSED', balanceAfter: null }, 'wt_balance_after_terminal');
    await expectTxRejected(
      w, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: null }, 'wt_balance_after_terminal',
    );
    await expectTxRejected(w, { balanceAfter: '-1.00' }, 'wt_balance_after_non_negative');
  });

  test('a PROCESSED reversal must have its reference resolved', async () => {
    const w = await createWallet();
    await expectTxRejected(
      w, { kind: 'REFUND', referenceExternalId: 'bet-x', referenceTxId: null }, 'wt_processed_reversal_resolved',
    );
  });

  test('PENDING_REFERENCE reversal is accepted without a resolved reference', async () => {
    const w = await createWallet();
    await insertTx(w, { kind: 'ROLLBACK', referenceExternalId: 'not-yet', status: 'PENDING_REFERENCE' });
  });

  test('transaction must belong to an existing wallet', async () => {
    const ghost: WalletFixture = { walletId: uuid(), playerId: uuid(), openingTxId: null };
    await expectTxRejected(ghost, {}, 'wager_transactions_wallet_id_fkey');
  });

  test('a reference cannot be reversed twice by the same kind', async () => {
    const w = await createWallet();
    const betId = uuid();
    await insertTx(w, { id: betId, externalId: 'bet-rev' });
    const refund = { kind: 'REFUND', referenceExternalId: 'bet-rev', referenceTxId: betId };

    await insertTx(w, refund);
    await expectTxRejected(w, refund, 'wt_single_reversal_uq');
    // tipo diferente sobre a mesma referência não é bloqueado pelo índice
    await insertTx(w, { ...refund, kind: 'ROLLBACK' });
  });

  test('a REJECTED reversal does not block a later PROCESSED one', async () => {
    const w = await createWallet();
    const betId = uuid();
    await insertTx(w, { id: betId, externalId: 'bet-rej' });
    const refund = { kind: 'REFUND', referenceExternalId: 'bet-rej', referenceTxId: betId };

    await insertTx(w, { ...refund, status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW' });
    await insertTx(w, refund);
  });
});

describe('wallet_ledger_entries', () => {
  test('rejects entries whose arithmetic does not balance', async () => {
    const w = await createWallet('0.00');
    const txId = uuid();
    await insertTx(w, { id: txId, kind: 'WIN', balanceAfter: '10.00' });
    const [s1, p1] = ledgerInsert(w.walletId, txId, 2, 'CREDIT', '10.00', '0.00', '9.99');
    await expectRejected(s1, p1, 'ledger_arithmetic');
    const [s2, p2] = ledgerInsert(w.walletId, txId, 2, 'DEBIT', '10.00', '0.00', '10.00');
    await expectRejected(s2, p2, 'ledger_arithmetic');
  });

  test('rejects a debit that would leave a negative balance', async () => {
    const w = await createWallet('0.00');
    const txId = uuid();
    await insertTx(w, { id: txId, balanceAfter: '0.00' });
    const [s, p] = ledgerInsert(w.walletId, txId, 2, 'DEBIT', '10.00', '0.00', '-10.00');
    await expectRejected(s, p, 'ledger_balances_non_negative');
  });

  test('rejects a non-positive amount', async () => {
    const w = await createWallet('0.00');
    const txId = uuid();
    await insertTx(w, { id: txId, kind: 'WIN' });
    const [s, p] = ledgerInsert(w.walletId, txId, 2, 'CREDIT', '0.00', '0.00', '0.00');
    await expectRejected(s, p, 'ledger_amount_positive');
  });

  test('at most one entry per (wallet, transaction)', async () => {
    const w = await createWallet();
    const [s, p] = ledgerInsert(w.walletId, w.openingTxId!, 2, 'CREDIT', '100.00', '100.00', '200.00');
    await expectRejected(s, p, 'ledger_wallet_transaction_uq');
  });

  test('at most one entry per (wallet, wallet_version)', async () => {
    const w = await createWallet();
    const txId = uuid();
    await insertTx(w, { id: txId, kind: 'WIN', balanceAfter: '110.00' });
    const [s, p] = ledgerInsert(w.walletId, txId, 1, 'CREDIT', '10.00', '100.00', '110.00');
    await expectRejected(s, p, 'ledger_wallet_version_uq');
  });

  test('entry currency must match the wallet currency', async () => {
    const w = await createWallet('0.00');
    const txId = uuid();
    await insertTx(w, { id: txId, kind: 'WIN' });
    const [s, p] = ledgerInsert(w.walletId, txId, 2, 'CREDIT', '10.00', '0.00', '10.00', 'USD');
    await expectRejected(s, p, 'ledger_wallet_currency_fk');
  });

  test('entry wallet must match the transaction wallet', async () => {
    const a = await createWallet('0.00');
    const b = await createWallet('0.00');
    const txOfA = uuid();
    await insertTx(a, { id: txOfA, kind: 'WIN' });
    const [s, p] = ledgerInsert(b.walletId, txOfA, 2, 'CREDIT', '10.00', '0.00', '10.00');
    await expectRejected(s, p, 'ledger_transaction_wallet_fk');
  });

  test('UPDATE is blocked by the trigger', async () => {
    const w = await createWallet();
    await expectRejected(
      `UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [w.walletId], 'append-only: UPDATE',
    );
  });

  test('DELETE is blocked by the trigger', async () => {
    const w = await createWallet();
    await expectRejected(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.walletId],
      'append-only: DELETE');
  });

  test('TRUNCATE is blocked by the trigger', async () => {
    await expectRejected(`TRUNCATE wallet_ledger_entries CASCADE`, [], 'append-only: TRUNCATE');
  });
});

describe('inbox', () => {
  test('(consumer_name, message_id) is unique; ON CONFLICT DO NOTHING detects the duplicate', async () => {
    const insert = `INSERT INTO inbox (consumer_name, message_id, payload_hash) VALUES ('wager-consumer', ?, ?)`;
    const first = await sql(`${insert} ON CONFLICT DO NOTHING RETURNING message_id`, ['msg-1', 'c'.repeat(64)]);
    const again = await sql(`${insert} ON CONFLICT DO NOTHING RETURNING message_id`, ['msg-1', 'c'.repeat(64)]);
    expect(first).toHaveLength(1);
    expect(again).toHaveLength(0);
    await expectRejected(insert, ['msg-1', 'c'.repeat(64)], 'inbox_pk');
  });

  test('the same message id is independent per consumer', async () => {
    await sql(`INSERT INTO inbox (consumer_name, message_id, payload_hash) VALUES ('other-consumer', 'msg-1', ?)`, [
      'c'.repeat(64),
    ]);
  });
});

describe('outbox', () => {
  test('new messages are pending and due immediately', async () => {
    const id = uuid();
    await sql(
      `INSERT INTO outbox (id, aggregate_id, event_type, payload, occurred_at) VALUES (?, ?, 'Test', '{}', now())`,
      [id, uuid()],
    );
    const due = await sql(
      `SELECT id FROM outbox WHERE published_at IS NULL AND next_attempt_at <= now() AND id = ?`, [id],
    );
    expect(due).toHaveLength(1);
  });

  test('attempts cannot be negative', async () => {
    await expectRejected(
      `INSERT INTO outbox (id, aggregate_id, event_type, payload, occurred_at, attempts)
       VALUES (?, ?, 'Test', '{}', now(), -1)`,
      [uuid(), uuid()], 'outbox_attempts_non_negative',
    );
  });
});

describe('invariant and reversibility', () => {
  test('every wallet balance equals the balance rebuilt from the ledger', async () => {
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });

  test('down drops every table and function; up recreates them', async () => {
    await orm.migrator.down({ to: 0 });
    const tables = await sql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'mikro_orm_migrations'`,
    );
    const functions = await sql(`SELECT proname FROM pg_proc WHERE proname = 'wallet_ledger_entries_forbid_mutation'`);
    expect(tables).toEqual([]);
    expect(functions).toEqual([]);

    await orm.migrator.up();
    const recreated = await sql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(recreated.map((r) => r.table_name)).toEqual([
      'inbox', 'mikro_orm_migrations', 'outbox', 'wager_transactions', 'wallet_ledger_entries', 'wallets',
    ]);
    expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  });
});
