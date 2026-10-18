import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { FailureCode, type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { MovementProps, Wallet } from '../../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import type { IdGenerator } from '../ports/id-generator';
import type { WagerTransactionRepository } from '../ports/unit-of-work';

/**
 * `decided`: a transação ficou PROCESSED ou REJECTED (com o lançamento, quando o saldo mudou).
 * `wait`: reversão sem referência utilizável; quem chama decide entre PENDING_REFERENCE, novo retry ou
 * expiração. `reference` é a referência encontrada mas ainda não aplicada (ausente: não encontrada).
 */
export type RuleOutcome =
  | { kind: 'decided'; entry?: WalletLedgerEntry }
  | { kind: 'wait'; reference: WagerTransaction | undefined };

/**
 * Regras de negócio com a wallet JÁ travada (`FOR UPDATE`). Usada pela submissão e pelo resolve de
 * PENDING_REFERENCE, para que os dois caminhos decidam exatamente igual.
 * Ordem: dono da wallet, moeda, regra do tipo (ARCHITECTURE 5.7 e 5.10).
 */
export async function decideUnderLock(
  tx: WagerTransaction,
  wallet: Wallet,
  transactions: WagerTransactionRepository,
  ids: IdGenerator,
  now: Date,
): Promise<RuleOutcome> {
  if (tx.playerId !== wallet.playerId) {
    tx.reject(FailureCode.PlayerMismatch, wallet.balance, now);
    return { kind: 'decided' };
  }
  if (tx.money.currency !== wallet.currency) {
    tx.reject(FailureCode.CurrencyMismatch, wallet.balance, now);
    return { kind: 'decided' };
  }
  const movement = { money: tx.money, transactionId: tx.id, entryId: ids.next(), at: now };
  switch (tx.kind) {
    case WagerTransactionKind.Bet: {
      if (wallet.balance.isLessThan(tx.money)) {
        tx.reject(tx.failureCodeForOverdraw(), wallet.balance, now);
        return { kind: 'decided' };
      }
      const entry = wallet.debit(movement);
      tx.markProcessed({ balanceAfter: wallet.balance, at: now });
      return { kind: 'decided', entry };
    }
    case WagerTransactionKind.Win: {
      // Uma referência em WIN é só informativa: guardada e no hash, nunca resolvida (ARCHITECTURE 5.10).
      const entry = wallet.credit(movement);
      tx.markProcessed({ balanceAfter: wallet.balance, at: now });
      return { kind: 'decided', entry };
    }
    case WagerTransactionKind.Loss:
      // Registra o resultado da rodada: sem efeito no saldo e sem lançamento. Referência só informativa.
      tx.markProcessed({ balanceAfter: wallet.balance, at: now });
      return { kind: 'decided' };
    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback:
      return decideReversal(tx, wallet, transactions, movement, now);
    default:
      throw new Error(`${tx.kind} cannot be submitted`);
  }
}

async function decideReversal(
  tx: WagerTransaction,
  wallet: Wallet,
  transactions: WagerTransactionRepository,
  movement: MovementProps,
  now: Date,
): Promise<RuleOutcome> {
  // A referência é lida sem lock próprio. Isso só é seguro porque `validateReference` confere a identidade
  // (provider, player, WALLET, rodada) ANTES do status: se ela passa, a referência é desta wallet, e toda
  // mudança de status de uma transação desta wallet acontece sob o lock que já seguramos. Uma referência de
  // outra wallet é rejeitada pela identidade (imutável), sem que o status dela, instável para nós, seja lido.
  // Em READ COMMITTED este SELECT, emitido depois do FOR UPDATE, enxerga tudo o que foi commitado antes.
  const reference = await transactions.findByProviderAndExternalId(
    tx.providerId,
    tx.referenceExternalTransactionId as string,
  );
  const resolution = tx.validateReference(reference);
  if (resolution.outcome === 'wait') return { kind: 'wait', reference };
  // Daqui em diante a referência existe; guardar o vínculo deixa a rejeição auditável.
  const ref = reference as WagerTransaction;
  if (resolution.outcome === 'reject') {
    tx.reject(resolution.failureCode, wallet.balance, now, ref.id);
    return { kind: 'decided' };
  }
  // Sob o lock e antes do INSERT/UPDATE: o índice wt_single_reversal_uq é a rede final, não o caminho normal
  // (se dependêssemos dele, a violação abortaria a transação em vez de gerar uma rejeição auditável).
  if (await transactions.existsProcessedReversalOf(ref.id)) {
    tx.reject(FailureCode.AlreadyReversed, wallet.balance, now, ref.id);
    return { kind: 'decided' };
  }
  const direction = tx.ledgerDirectionFor(ref);
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
    tx.reject(tx.failureCodeForOverdraw(), wallet.balance, now, ref.id);
    return { kind: 'decided' };
  }
  const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed({ referenceTransactionId: ref.id, balanceAfter: wallet.balance, at: now });
  return { kind: 'decided', entry };
}

/** Eventos de uma transação recém-decidida (ou que acabou de entrar em PENDING_REFERENCE). */
export function wagerEvents(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  context: () => EventContext,
): IntegrationEvent<unknown>[] {
  const events: IntegrationEvent<unknown>[] = [];
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(tx, context()));
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(tx, context()));
      break;
    case WagerTransactionStatus.PendingReference:
      events.push(WagerTransactionPendingReference.from(tx, context()));
      break;
    default:
      throw new Error(`No event for a ${tx.status} transaction`);
  }
  if (entry !== undefined) events.push(WalletBalanceChanged.from(wallet, entry, context()));
  return events;
}
