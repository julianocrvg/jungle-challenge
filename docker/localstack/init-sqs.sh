#!/bin/bash
set -euo pipefail

# Cria uma fila FIFO com DLQ. A DLQ vem primeiro: a fila principal referencia o ARN dela na RedrivePolicy.
create_fifo_with_dlq() {
  local name="$1"
  awslocal sqs create-queue --queue-name "${name}-dlq.fifo" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false

  local dlq_arn
  dlq_arn=$(awslocal sqs get-queue-attributes \
    --queue-url "http://localhost:4566/000000000000/${name}-dlq.fifo" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

  awslocal sqs create-queue --queue-name "${name}.fifo" \
    --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"
}

# Entrada: transações de aposta vindas dos provedores.
create_fifo_with_dlq wager-transactions
# Saída: eventos de integração publicados pela outbox (ARCHITECTURE 6). A DLQ serve aos consumidores desses eventos.
create_fifo_with_dlq wager-events

echo "SQS FIFO queues ready"
