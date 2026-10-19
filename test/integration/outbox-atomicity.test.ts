import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionalRepositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
  type WagerTransactionPayload,
} from '../../src/application/wagering/submit-wager-transaction';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';
import { BunIdGenerator } from '../../src/infrastructure/id/bun-id-generator';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestOrm, insertWallet, type Sql, sqlRunner, walletsDivergingFromLedger, type WalletFixture } from './support/database';
import { createTempFifoQueue, deleteQueue, drain, outboxPublisher, receiveAll, SQS, sqsPublisher } from './support/outbox';

/*
 * Eliminatória 6 (ARCHITECTURE 6.3 e 13): nenhum evento sai antes do commit da transação financeira, nem de uma
 * transação que não chegou ao commit. O unit of work é o real; um decorator deixa o INSERT da outbox acontecer de
 * verdade e só então falha, o pior momento possível: a linha da outbox já foi escrita quando a submissão explode.
 */

class InjectedFailure extends Error {}

/** Delega ao UoW real e falha DEPOIS de `outbox.append` ter executado o INSERT. */
class FailAfterOutboxInsert implements UnitOfWork {
  constructor(private readonly real: UnitOfWork) {}

  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.real.run((repositories) => work({
      ...repositories,
      outbox: {
        ...repositories.outbox,
        append: async (messages) => {
          await repositories.outbox.append(messages);
          throw new InjectedFailure('submission failed after the outbox INSERT');
        },
      },
    }));
  }
}

let orm: MikroORM;
let sql: Sql;
let sqs: SQSClient;
let eventsQueue: string;
let healthy: SubmitWagerTransaction;
let failing: SubmitWagerTransaction;

function useCase(unitOfWork: UnitOfWork): SubmitWagerTransaction {
  return new SubmitWagerTransaction(unitOfWork, new BunIdGenerator(), { now: () => new Date() }, DEFAULT_PENDING_REFERENCE_POLICY);
}

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  sqs = createSqsClient(SQS);
  eventsQueue = await createTempFifoQueue(sqs, 'outbox-atomicity');
  const real = new MikroOrmUnitOfWork(orm, 10_000);
  healthy = useCase(real);
  failing = useCase(new FailAfterOutboxInsert(real));
});

afterAll(async () => {
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  if (eventsQueue) await deleteQueue(sqs, eventsQueue);
  sqs?.destroy();
  await orm?.close(true);
});

function command(wallet: WalletFixture, amount: string): SubmitWagerTransactionCommand {
  const payload: WagerTransactionPayload = {
    providerId: 'provider-a',
    externalTransactionId: `ext-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
  };
  return { idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}`, payload, correlationId: Bun.randomUUIDv7() };
}

async function rows(table: string, column: string, walletId: string): Promise<number> {
  const [row] = await sql(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ?`, [walletId]);
  return row?.n as number;
}

/** Roda o publisher até esvaziar e devolve só os eventos desta wallet que chegaram à fila de eventos. */
async function publishedFor(walletId: string): Promise<string[]> {
  const { batch } = outboxPublisher({ orm, publisher: sqsPublisher(eventsQueue) });
  await drain(batch);
  const received = await receiveAll(sqs, eventsQueue, 0);
  return received.filter((event) => event.groupId === walletId).map((event) => event.eventType);
}

describe('outbox is written inside the financial transaction', () => {
  test('control: a healthy BET puts its two events on the events queue after the drain', async () => {
    const wallet = await insertWallet(sql, '100.00');
    await healthy.execute(command(wallet, '80.00'));
    expect(await rows('outbox', 'aggregate_id', wallet.walletId)).toBe(2);
    expect((await publishedFor(wallet.walletId)).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('BET failing right after the outbox INSERT: nothing is committed and the drain publishes nothing', async () => {
    const wallet = await insertWallet(sql, '100.00');
    await expect(failing.execute(command(wallet, '80.00'))).rejects.toBeInstanceOf(InjectedFailure);

    const [balance] = await sql(`SELECT balance::text AS balance, version FROM wallets WHERE id = ?`, [wallet.walletId]);
    expect(balance).toMatchObject({ balance: '100.00', version: 1 });
    expect(await rows('wager_transactions', 'wallet_id', wallet.walletId)).toBe(1); // só a OPENING do fixture
    expect(await rows('wallet_ledger_entries', 'wallet_id', wallet.walletId)).toBe(1);
    expect(await rows('outbox', 'aggregate_id', wallet.walletId)).toBe(0);

    expect(await publishedFor(wallet.walletId)).toEqual([]);
    expect(await rows('outbox', 'aggregate_id', wallet.walletId)).toBe(0);
  });

  test('REJECTED (insufficient funds) failing right after the outbox INSERT: no rejection row, no event', async () => {
    const wallet = await insertWallet(sql, '10.00');
    await expect(failing.execute(command(wallet, '80.00'))).rejects.toBeInstanceOf(InjectedFailure);

    expect(await rows('wager_transactions', 'wallet_id', wallet.walletId)).toBe(1);
    expect(await rows('outbox', 'aggregate_id', wallet.walletId)).toBe(0);
    expect(await publishedFor(wallet.walletId)).toEqual([]);
  });
});
