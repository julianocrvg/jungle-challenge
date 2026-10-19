import { TransientInfrastructureError } from '../../application/errors';
import type { MessageQueue, ReceivedMessage } from '../../application/ports/message-queue';
import type { Metrics } from '../../application/ports/metrics';
import type { LogFields, StructuredLogger } from '../../application/ports/structured-logger';
import type { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { type BackoffPolicy, backoffDelayMs } from '../../domain/backoff';
import { sqlStateOf } from '../../infrastructure/persistence/database-errors';
import { classifyFailure } from '../messaging/failure-classification';
import { InvalidMessageError, parseWagerMessage } from '../messaging/wager-message';
import { errorFields } from '../../infrastructure/logging/describe-error';
import { enrichContext, runWithContext } from '../../infrastructure/logging/request-context';

export interface WagerConsumerOptions {
  /** Se falso, o laço não sobe com a aplicação. */
  enabled: boolean;
  consumerName: string;
  maxAttempts: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  concurrency: number;
  /** Backoff das falhas transitórias de infraestrutura. */
  backoff: BackoffPolicy;
  /** Backoff curto do erro inesperado (bug): repete logo, até o limite, em vez de descartar. */
  unexpectedBackoff: BackoffPolicy;
  /** lock_timeout + margem: uma mensagem cuja visibilidade acaba antes disso é devolvida sem começar (7.4). */
  processingBudgetMs: number;
  /** Espera depois de uma falha no ReceiveMessage (SQS fora do ar). */
  receiveErrorDelayMs: number;
  /** maxReceiveCount do redrive precisa ser pelo menos este múltiplo de maxAttempts (7.4). */
  redriveSafetyFactor: number;
  /** Vai no log de cada mensagem: mostra qual instância a consumiu (ARCHITECTURE 10.2). */
  instanceId?: string;
}

type Next = 'continue' | 'hold-group';

const MAX_RECEIVE_BATCH = 10;
const MAX_VISIBILITY_SECONDS = 12 * 60 * 60;

/**
 * Consumidor de wager-transactions.fifo numa instância (ARCHITECTURE 7). Cada mensagem passa pelo MESMO use
 * case do HTTP, com a inbox na mesma transação SQL; o ack (DeleteMessage) vem só depois do commit.
 *
 * Um lote recebido é dividido por MessageGroupId: grupos em paralelo (até `concurrency`), mensagens de um grupo
 * em sequência. Se uma mensagem do grupo fica para retry, as seguintes do grupo são devolvidas (visibilidade 0)
 * e o FIFO só as entrega de novo depois dela. Isso é otimização de ordem: a consistência é do banco.
 */
export class WagerTransactionsConsumer {
  private running: Promise<void> | undefined;
  private stopping = false;
  private pollAbort: AbortController | undefined;
  private wake: (() => void) | undefined;
  /** Recebidas e ainda não iniciadas: o shutdown devolve a visibilidade delas na hora. */
  private readonly notStarted = new Set<ReceivedMessage>();
  private releasing: Promise<void> = Promise.resolve();

  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly queue: MessageQueue,
    private readonly metrics: Metrics,
    private readonly logger: StructuredLogger,
    private readonly options: WagerConsumerOptions,
  ) {}

  /** Hook do Nest: confere o redrive da fila e sobe o laço. */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.enabled) return;
    await this.verifyRedrivePolicy();
    this.start();
  }

  /** Hook do Nest (app.close() ou SIGTERM), antes de o pool do ORM fechar. */
  beforeApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  start(): void {
    if (this.running !== undefined) return;
    this.stopping = false;
    this.running = this.loop();
  }

  /**
   * Shutdown (ARCHITECTURE 7.7): aborta o long poll, devolve na hora a visibilidade das recebidas que não
   * começaram e espera as em andamento chegarem ao commit e ao ack.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.pollAbort?.abort();
    this.wake?.();
    const pending = [...this.notStarted];
    this.notStarted.clear();
    this.releasing = this.release(pending, 'shutdown');
    await Promise.all([this.running, this.releasing]);
    this.running = undefined;
  }

  /**
   * Com redrive menor que `redriveSafetyFactor × maxAttempts`, mensagens devolvidas sem processar (seguidoras
   * de um grupo em retry) poderiam ir para a DLQ do SQS sem nunca terem sido tentadas (7.4).
   */
  async verifyRedrivePolicy(): Promise<void> {
    const maxReceiveCount = await this.queue.redriveMaxReceiveCount();
    const required = this.options.redriveSafetyFactor * this.options.maxAttempts;
    if (maxReceiveCount === undefined) {
      this.logger.warn('Wager queue has no redrive policy; only the consumer moves messages to the DLQ', {});
      return;
    }
    if (maxReceiveCount < required) {
      throw new Error(
        `Redrive maxReceiveCount (${maxReceiveCount}) must be at least ${this.options.redriveSafetyFactor} x `
        + `SQS_CONSUMER_MAX_ATTEMPTS (${this.options.maxAttempts}) = ${required}`,
      );
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const abort = new AbortController();
      this.pollAbort = abort;
      let batch: ReceivedMessage[];
      try {
        batch = await this.queue.receive({
          maxMessages: MAX_RECEIVE_BATCH,
          waitTimeSeconds: this.options.waitTimeSeconds,
          visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
        }, abort.signal);
      } catch (error) {
        if (this.stopping) break; // o abort do shutdown cai aqui
        this.metrics.increment('sqs_consumer_receive_errors_total');
        this.logger.warn('Wager queue receive failed', { ...errorFields(error) });
        await this.idle(this.options.receiveErrorDelayMs);
        continue;
      } finally {
        this.pollAbort = undefined;
      }
      if (this.stopping) {
        // Chegou junto com o abort: nada começou, devolve tudo.
        await this.release(batch, 'shutdown');
        break;
      }
      await this.processBatch(batch);
    }
  }

  private async processBatch(batch: ReceivedMessage[]): Promise<void> {
    for (const message of batch) this.notStarted.add(message);
    const groups = new Map<string, ReceivedMessage[]>();
    for (const message of batch) groups.set(message.groupId, [...(groups.get(message.groupId) ?? []), message]);
    const queue = [...groups.values()];
    const workers = Array.from({ length: Math.min(this.options.concurrency, queue.length) }, async () => {
      for (let group = queue.shift(); group !== undefined; group = queue.shift()) await this.processGroup(group);
    });
    await Promise.all(workers);
  }

  private async processGroup(group: ReceivedMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      // Já devolvida pelo shutdown: o resto do grupo também foi.
      if (!this.notStarted.delete(message)) return;
      const rest = group.slice(index + 1);
      if (this.stopping) {
        await this.release([message, ...this.takeNotStarted(rest)], 'shutdown');
        return;
      }
      if (Date.now() > message.receivedAt + this.options.visibilityTimeoutSeconds * 1000 - this.options.processingBudgetMs) {
        // A visibilidade acabaria no meio do processamento: devolve em vez de começar.
        await this.release([message, ...this.takeNotStarted(rest)], 'lease_expiring');
        return;
      }
      if (await this.handle(message) === 'hold-group') {
        await this.release(this.takeNotStarted(rest), 'group_on_hold');
        return;
      }
    }
  }

  /** Tira do conjunto as que ainda não começaram nem foram devolvidas pelo shutdown. */
  private takeNotStarted(messages: ReceivedMessage[]): ReceivedMessage[] {
    return messages.filter((message) => this.notStarted.delete(message));
  }

  /** Um contexto de log por mensagem; o `messageId` vira o `correlationId` assim que a mensagem é lida (ARCHITECTURE 11.3). */
  private handle(message: ReceivedMessage): Promise<Next> {
    return runWithContext({ correlationId: message.transportId }, () => this.handleInContext(message));
  }

  private async handleInContext(message: ReceivedMessage): Promise<Next> {
    const started = performance.now();
    let context: Record<string, string | number | undefined> = {
      instanceId: this.options.instanceId,
      sqsMessageId: message.transportId,
      receiveCount: message.receiveCount,
    };
    try {
      const parsed = parseWagerMessage(message.body);
      context = {
        ...context,
        messageId: parsed.messageId,
        correlationId: parsed.messageId,
        walletId: parsed.payload.walletId,
        providerId: parsed.payload.providerId,
      };
      enrichContext({ messageId: parsed.messageId, correlationId: parsed.messageId, walletId: parsed.payload.walletId, providerId: parsed.payload.providerId });
      const result = await this.submit.execute({
        idempotencyKey: parsed.idempotencyKey,
        payload: parsed.payload,
        correlationId: parsed.messageId,
        causationId: message.transportId,
        inbox: { consumerName: this.options.consumerName, messageId: parsed.messageId },
      });
      const outcome = result.duplicateDelivery ? 'duplicate' : result.idempotentReplay ? 'replay' : result.transaction.status;
      // Duplicatas são contadas pelo use case (`wager_duplicates_total{source="sqs"}`), depois do commit.
      this.metrics.increment('sqs_consumer_messages_total', { outcome });
      enrichContext({ transactionId: result.transaction.id });
      context = { ...context, transactionId: result.transaction.id, status: result.transaction.status, outcome };
      // O commit já aconteceu: só agora o ack.
      await this.ack(message, context);
      this.logger.info('Wager message processed', context);
      return 'continue';
    } catch (error) {
      return await this.handleFailure(message, error, context);
    } finally {
      this.metrics.observe('sqs_consumer_processing_seconds', (performance.now() - started) / 1000);
    }
  }

  private async handleFailure(message: ReceivedMessage, error: unknown, context: LogFields): Promise<Next> {
    const disposition = classifyFailure(error);
    if (disposition.kind === 'permanent') return this.deadLetter(message, disposition.reason, disposition.reason, context);

    if (disposition.unexpected) {
      // Bug: só os frames do stack. A mensagem do erro é texto livre (pode citar valores ou o SQL) e fica fora.
      this.logger.error('Unexpected error processing wager message', {
        ...context, ...errorFields(error),
      });
    }
    // Para falhas de banco, o SQLSTATE (55P03, 40P01...) é o motivo mais útil na métrica.
    const reason = (error instanceof TransientInfrastructureError ? sqlStateOf(error.cause) : undefined) ?? disposition.reason;
    if (message.receiveCount >= this.options.maxAttempts) {
      return this.deadLetter(message, 'MAX_ATTEMPTS_EXCEEDED', reason, context);
    }
    const policy = disposition.unexpected ? this.options.unexpectedBackoff : this.options.backoff;
    const delaySeconds = Math.min(Math.max(1, Math.ceil(backoffDelayMs(message.receiveCount, policy) / 1000)), MAX_VISIBILITY_SECONDS);
    this.metrics.increment('sqs_consumer_retries_total', { reason });
    this.logger.warn('Wager message will be retried', { ...context, reason, delaySeconds });
    try {
      await this.queue.changeVisibility(message, delaySeconds);
    } catch (changeError) {
      // Sem a mudança, a mensagem volta quando a visibilidade original acabar: só fica mais lenta.
      this.logger.warn('ChangeMessageVisibility failed', { ...context, ...errorFields(changeError) });
    }
    return 'hold-group';
  }

  /**
   * Erro permanente ou tentativas esgotadas: copia para a DLQ com o motivo e só então faz o ack. Se a cópia
   * falhar, não há ack: a mensagem volta pela visibilidade e nunca se perde (ARCHITECTURE 7.6).
   */
  private async deadLetter(message: ReceivedMessage, reason: string, detail: string, context: LogFields): Promise<Next> {
    try {
      await this.queue.sendToDeadLetter(message, { reason, detail });
    } catch (error) {
      this.metrics.increment('sqs_consumer_dlq_send_failures_total');
      this.logger.error('Failed to move wager message to the DLQ', { ...context, reason, ...errorFields(error) });
      return 'hold-group';
    }
    this.metrics.increment('sqs_consumer_dlq_total', { reason });
    this.metrics.increment('sqs_consumer_messages_total', { outcome: 'dead_lettered' });
    this.logger.warn('Wager message moved to the DLQ', { ...context, reason });
    await this.ack(message, context);
    return 'continue';
  }

  /** Falha no ack não desfaz nada: a mensagem volta e a inbox a reconhece como duplicata. */
  private async ack(message: ReceivedMessage, context: LogFields): Promise<void> {
    try {
      await this.queue.delete(message);
    } catch (error) {
      this.metrics.increment('sqs_consumer_ack_failures_total');
      this.logger.warn('DeleteMessage failed; the message will be redelivered', { ...context, ...errorFields(error) });
    }
  }

  private async release(messages: ReceivedMessage[], reason: string): Promise<void> {
    await Promise.all(messages.map(async (message) => {
      try {
        await this.queue.changeVisibility(message, 0);
        this.metrics.increment('sqs_consumer_released_total', { reason });
      } catch (error) {
        // Volta sozinha quando a visibilidade acabar.
        this.logger.warn('Failed to release wager message', { sqsMessageId: message.transportId, ...errorFields(error) });
      }
    }));
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wake?.(), ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
