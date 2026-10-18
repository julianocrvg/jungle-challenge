import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InboxMessageConflictError, WalletNotFoundError } from '../../src/application/errors';
import {
  type SubmitWagerTransactionCommand,
  SubmitWagerTransaction,
  type WagerTransactionPayload,
} from '../../src/application/wagering/submit-wager-transaction';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { BunIdGenerator } from '../../src/infrastructure/id/bun-id-generator';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestOrm, insertWallet, type Sql, sqlRunner, walletsDivergingFromLedger, type WalletFixture } from './support/database';

/*
 * A inbox dentro da transação da submissão (ARCHITECTURE 7.2), chamando o use case direto, sem fila:
 * duplicata decidida pela PK, conflito de messageId, atomicidade com a mudança financeira e entregas concorrentes.
 */

const CONSUMER = 'wager-transactions';

let orm: MikroORM;
let sql: Sql;
let submit: SubmitWagerTransaction;

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  submit = new SubmitWagerTransaction(
    new MikroOrmUnitOfWork(orm, 10_000), new BunIdGenerator(), { now: () => new Date() }, DEFAULT_PENDING_REFERENCE_POLICY,
  );
});

afterAll(async () => {
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  await orm?.close(true);
});

function bet(wallet: WalletFixture, overrides: Partial<WagerTransactionPayload> = {}): WagerTransactionPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function fromQueue(payload: WagerTransactionPayload, messageId = `msg-${Bun.randomUUIDv7()}`): SubmitWagerTransactionCommand {
  return {
    idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`,
    payload,
    correlationId: messageId,
    inbox: { consumerName: CONSUMER, messageId },
  };
}

async function count(table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return row?.n as number;
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql(`SELECT balance::text AS balance FROM wallets WHERE id = ?`, [walletId]);
  return row?.balance as string;
}

describe('inbox in the submission transaction', () => {
  test('first delivery writes inbox, transaction, ledger and outbox; redelivery is a duplicate with no effect', async () => {
    const wallet = await insertWallet(sql);
    const command = fromQueue(bet(wallet));

    const first = await submit.execute(command);
    expect(first).toMatchObject({ idempotentReplay: false, duplicateDelivery: false });
    const [inbox] = await sql(`SELECT processed_at, received_at FROM inbox WHERE message_id = ?`, [command.inbox?.messageId]);
    expect(inbox?.processed_at).not.toBeNull();
    const outboxAfterFirst = await count('outbox');

    const again = await submit.execute(command);
    expect(again).toMatchObject({ idempotentReplay: true, duplicateDelivery: true });
    expect(again.transaction.id).toBe(first.transaction.id);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await count('wallet_ledger_entries', 'transaction_id = ?', [first.transaction.id])).toBe(1);
    expect(await count('outbox')).toBe(outboxAfterFirst);
  });

  test('same messageId with a different payload is a conflict and writes nothing', async () => {
    const wallet = await insertWallet(sql);
    const original = fromQueue(bet(wallet));
    await submit.execute(original);
    const outboxBefore = await count('outbox');

    const different = fromQueue(bet(wallet, { money: { amount: '30.00', currency: 'BRL' } }), original.inbox?.messageId);
    await expect(submit.execute(different)).rejects.toBeInstanceOf(InboxMessageConflictError);
    // A mesma key com outro messageId também é conflito na inbox se mudar só a key.
    const otherKey = { ...original, idempotencyKey: 'provider-a:other-key' };
    await expect(submit.execute(otherKey)).rejects.toBeInstanceOf(InboxMessageConflictError);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
    expect(await count('outbox')).toBe(outboxBefore);
    expect(await count('wager_transactions', 'idempotency_key = ?', [otherKey.idempotencyKey])).toBe(0);
  });

  test('a new messageId for the same business transaction is an idempotency replay, not an inbox duplicate', async () => {
    const wallet = await insertWallet(sql);
    const payload = bet(wallet);
    const [a, b] = [fromQueue(payload), fromQueue(payload)];
    const first = await submit.execute(a);
    const replay = await submit.execute(b);
    expect(replay).toMatchObject({ idempotentReplay: true, duplicateDelivery: false });
    expect(replay.transaction.id).toBe(first.transaction.id);
    // A inbox registra as duas mensagens; o efeito financeiro é um só.
    expect(await count('inbox', 'message_id IN (?, ?)', [a.inbox?.messageId, b.inbox?.messageId])).toBe(2);
    expect(await balanceOf(wallet.walletId)).toBe('75.00');
  });

  test('a business rejection is persisted together with the inbox', async () => {
    const wallet = await insertWallet(sql, '10.00');
    const command = fromQueue(bet(wallet));
    const result = await submit.execute(command);
    expect(result.transaction.status).toBe('REJECTED' as never);
    expect(await count('inbox', 'message_id = ?', [command.inbox?.messageId])).toBe(1);
    expect((await submit.execute(command)).duplicateDelivery).toBe(true);
  });

  test('wallet not found rolls back the inbox: nothing is persisted', async () => {
    const ghost: WalletFixture = { walletId: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), openingTxId: null };
    const command = fromQueue(bet(ghost));
    await expect(submit.execute(command)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(await count('inbox', 'message_id = ?', [command.inbox?.messageId])).toBe(0);
  });

  test('an error after the inbox insert rolls the inbox back (same SQL transaction)', async () => {
    const wallet = await insertWallet(sql);
    const original = fromQueue(bet(wallet));
    await submit.execute(original);
    // Mesma key, outro payload, messageId novo: a inbox é inserida e depois desfeita pelo 409 da key.
    const conflicting = { ...fromQueue(bet(wallet, { money: { amount: '1.00', currency: 'BRL' } })), idempotencyKey: original.idempotencyKey };
    await expect(submit.execute(conflicting)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(await count('inbox', 'message_id = ?', [conflicting.inbox?.messageId])).toBe(0);
  });
});
