/** Uma mensagem recebida e ainda não apagada (em voo, invisível para os outros consumidores). */
export interface ReceivedMessage {
  /** `MessageId` atribuído pelo SQS. Não é o `messageId` do envelope, que é do produtor. */
  transportId: string;
  receiptHandle: string;
  body: string;
  /** `MessageGroupId`: a ordem dentro do grupo é só otimização (ARCHITECTURE 7.5). */
  groupId: string;
  /**
   * `ApproximateReceiveCount`. Conta toda entrega, inclusive as que o consumidor devolveu sem processar
   * (visibilidade 0), então é um teto do número real de tentativas (ARCHITECTURE 7.4).
   */
  receiveCount: number;
  /** `Date.now()` do recebimento: base do prazo de visibilidade. */
  receivedAt: number;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
}

export interface DeadLetter {
  /** Motivo legível por máquina (`failureReason` na DLQ). */
  reason: string;
  /** Detalhe curto, sem payload financeiro. */
  detail: string;
}

/** Porta da fila de entrada. O ack é `delete`; nada aqui é chamado antes do commit da submissão. */
export interface MessageQueue {
  /** Long polling. O `signal` aborta a espera no shutdown. */
  receive(options: ReceiveOptions, signal: AbortSignal): Promise<ReceivedMessage[]>;
  delete(message: ReceivedMessage): Promise<void>;
  changeVisibility(message: ReceivedMessage, seconds: number): Promise<void>;
  /** Copia a mensagem para a DLQ com o motivo. Não apaga da fila de origem: o chamador faz o ack depois. */
  sendToDeadLetter(message: ReceivedMessage, letter: DeadLetter): Promise<void>;
  /** `maxReceiveCount` da RedrivePolicy da fila, se houver. */
  redriveMaxReceiveCount(): Promise<number | undefined>;
}

export const MESSAGE_QUEUE = Symbol('MessageQueue');
