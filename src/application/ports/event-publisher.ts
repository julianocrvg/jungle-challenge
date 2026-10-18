import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * Falha de uma entrada do lote. `sender`: o serviço recusou a entrada por culpa nossa (payload, atributos);
 * `service`: falha do lado do serviço. As duas recebem retry; `sender` indica bug e é logada como erro.
 */
export interface PublishFailure {
  id: string;
  fault: 'sender' | 'service';
  code: string;
  message: string;
}

export interface PublishResult {
  /** Ids (eventId) aceitos pelo broker. */
  published: string[];
  failed: PublishFailure[];
}

/**
 * Broker de eventos de integração. Uma exceção significa que a chamada inteira falhou (rede, timeout,
 * fila inexistente): o resultado é ambíguo, e as mensagens podem ou não ter sido aceitas.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[], signal: AbortSignal): Promise<PublishResult>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');
