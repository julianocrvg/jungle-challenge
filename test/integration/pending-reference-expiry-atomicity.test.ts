import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TransactionalRepositories, UnitOfWork } from '../../src/application/ports/unit-of-work';
import { ResolvePendingReference } from '../../src/application/wagering/resolve-pending-reference';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/pending-reference-policy';
import { BunIdGenerator } from '../../src/infrastructure/id/bun-id-generator';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createWalletViaApi, startTestApp, submit, type TestApp, wagerPayload } from './support/app';
import { createTestOrm, type Sql, sqlRunner, walletsDivergingFromLedger } from './support/database';
import { createTempFifoQueue, deleteQueue, drain, ManualClock, outboxPublisher, receiveAll, SQS, sqsPublisher } from './support/outbox';

/*
 * Atomicidade da expiração de PENDING_REFERENCE (ARCHITECTURE 6.3 e 13, eliminatória 6): a mudança para REJECTED e o
 * evento WagerTransactionRejected confirmam ou desfazem juntos. O unit of work é o real; o decorator deixa o INSERT
 * da outbox executar e só então lança, o pior momento: a linha do evento já foi escrita quando o resolve explode.
 */

class InjectedFailure extends Error {}

class FailAfterOutboxInsert implements UnitOfWork {
  constructor(private readonly real: UnitOfWork) {}

  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    return this.real.run((repositories) => work({
      ...repositories,
      outbox: {
        ...repositories.outbox,
        append: async (messages) => {
          await repositories.outbox.append(messages);
          throw new InjectedFailure('expiry failed after the outbox INSERT');
        },
      },
    }));
  }
}

const TTL = DEFAULT_PENDING_REFERENCE_POLICY.ttlMs;
const clock = new ManualClock(new Date());

let orm: MikroORM;
let sql: Sql;
let api: TestApp;
let sqs: SQSClient;
let eventsQueue: string;
let healthyResolver: ResolvePendingReference;
let failingResolver: ResolvePendingReference;

beforeAll(async () => {
  orm = await createTestOrm();
  sql = sqlRunner(orm);
  api = await startTestApp({ clock });
  sqs = createSqsClient(SQS);
  eventsQueue = await createTempFifoQueue(sqs, 'pending-expiry');
  healthyResolver = api.app.get(ResolvePendingReference);
  const build = (uow: UnitOfWork) =>
    new ResolvePendingReference(uow, new BunIdGenerator(), clock, DEFAULT_PENDING_REFERENCE_POLICY);
  failingResolver = build(new FailAfterOutboxInsert(new MikroOrmUnitOfWork(orm, 10_000)));
});

afterAll(async () => {
  expect(await walletsDivergingFromLedger(sql)).toEqual([]);
  await api?.close();
  if (eventsQueue) await deleteQueue(sqs, eventsQueue);
  sqs?.destroy();
  await orm?.close(true);
});

async function txRow(id: string) {
  const [row] = await sql(
    `SELECT status, failure_code, attempts, next_attempt_at FROM wager_transactions WHERE id = ?`, [id],
  );
  return row;
}

async function outboxTypes(transactionId: string): Promise<string[]> {
  const rows = await sql(
    `SELECT event_type FROM outbox WHERE payload->'data'->>'transactionId' = ? ORDER BY occurred_at, id`, [transactionId],
  );
  return rows.map((r) => r.event_type as string);
}

/** Publica (com o relógio manual do app: o evento nasce com next_attempt_at nele) tudo o que está confirmado na outbox e devolve os tipos de evento desta wallet que chegaram à fila. */
async function publishedFor(walletId: string): Promise<string[]> {
  const { batch } = outboxPublisher({ orm, publisher: sqsPublisher(eventsQueue), clock });
  await drain(batch);
  const received = await receiveAll(sqs, eventsQueue, 0);
  return received.filter((event) => event.groupId === walletId).map((event) => event.eventType);
}

describe('expiry of PENDING_REFERENCE is atomic with the Rejected event', () => {
  test('a failure right after the outbox INSERT leaves the transaction pending, no Rejected row, nothing on the queue; a healthy retry then expires it', async () => {
    const wallet = await createWalletViaApi(api, '100.00');
    const payload = wagerPayload(wallet, {
      kind: 'REFUND', money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: `missing-${Bun.randomUUIDv7()}`,
    });
    const created = await submit(api, payload);
    expect(created.status).toBe(202);
    const id = created.body.transactionId as string;
    const before = await txRow(id);
    expect(before).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0 });

    clock.advance(TTL);
    await expect(failingResolver.execute(id)).rejects.toBeInstanceOf(InjectedFailure);

    // Nada da expiração foi confirmado: mesmo estado, mesmas tentativas, mesmo agendamento.
    expect(await txRow(id)).toEqual(before);
    expect(await outboxTypes(id)).toEqual(['WagerTransactionPendingReference']);
    // O drain só enxerga o que foi confirmado: o da criação da wallet e o de entrada da reversão, nunca o Rejected.
    expect(await publishedFor(wallet.id)).toEqual(['WalletBalanceChanged', 'WagerTransactionPendingReference']);

    // Controle: sem a falha, o mesmo resolve expira e o Rejected sai.
    expect((await healthyResolver.execute(id)).outcome).toBe('expired');
    expect(await txRow(id)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(await outboxTypes(id)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await publishedFor(wallet.id)).toEqual(['WagerTransactionRejected']);
  });
});
