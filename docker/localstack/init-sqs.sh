#!/bin/bash
set -euo pipefail

# Cria uma fila FIFO com DLQ. A DLQ vem primeiro: a fila principal referencia o ARN dela na RedrivePolicy.
create_fifo_with_dlq() {
  local name="$1"
  local max_receive_count="$2"
  awslocal sqs create-queue --queue-name "${name}-dlq.fifo" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false

  local dlq_arn
  dlq_arn=$(awslocal sqs get-queue-attributes \
    --queue-url "http://localhost:4566/000000000000/${name}-dlq.fifo" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

  awslocal sqs create-queue --queue-name "${name}.fifo" \
    --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${max_receive_count}\\\"}\"}"
}

# Entrada: transações de aposta vindas dos provedores. O redrive (15) é rede de segurança: o consumidor manda
# para a DLQ depois de SQS_CONSUMER_MAX_ATTEMPTS (5), e o redrive precisa ser >= 3x isso (ARCHITECTURE 7.4).
create_fifo_with_dlq wager-transactions 15
# Saída: eventos de integração publicados pela outbox (ARCHITECTURE 6). A DLQ serve aos consumidores desses eventos.
create_fifo_with_dlq wager-events 5

echo "SQS FIFO queues ready"
