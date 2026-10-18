# TODO

## Fatia 4: submissão via HTTP (concluída)

Decisões detalhadas em ARCHITECTURE.md, seções 5.2 a 5.9.

- [x] Migration 0003: failure code `PLAYER_MISMATCH` e `CHECK` que reserva `provider_id = 'internal'` para `OPENING`
- [x] Domínio: `PLAYER_MISMATCH`; `create` recusa o provider reservado `internal`; `reject` aceita o saldo observado na moeda da wallet
- [x] Config: pool com pelo menos 20 conexões (`DB_POOL_MAX`, default 20) e `lock_timeout` configurável (`DB_LOCK_TIMEOUT_MS`, default 10000)
- [x] `payloadHash`: SHA-256 do JSON canônico (chaves ordenadas) dos campos de negócio
- [x] Use case `CreateWallet`: `ON CONFLICT (player_id, currency) DO NOTHING` → 409; com saldo > 0, OPENING sintética + lançamento em v1 + `WalletBalanceChanged` na outbox
- [x] Use case `SubmitWagerTransaction`: lock → decisão sob o lock → `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` no estado final → ledger, `UPDATE ... WHERE version = ?` e outbox
- [x] 23505 mapeado pelo nome da constraint: só `wt_provider_external_uq` vira 409; qualquer outro vira 500 com log
- [x] 501 temporário para qualquer requisição com `referenceExternalTransactionId` (sai na 4b)
- [x] HTTP: validador escrito à mão; `Idempotency-Key` obrigatório, com no máximo 255 caracteres ASCII visíveis e sem o prefixo `internal:`; filtro único de erros
- [x] Corpo das transações: `{transactionId, status, failureCode, balance, idempotentReplay}`. Corpo dos erros: `{code, message}`
- [x] Testes de unidade: hash, validador, classificação de erros de banco, domínio
- [x] Testes de integração HTTP: wallet, BET/WIN/LOSS, replay, conflitos 409, 404 sem persistir, `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, outbox atômica, 23505 desconhecido → 500, 503 com `Retry-After`
- [x] Testes de concorrência: 2 apostas de 80 sobre 100; mesma aposta 50 vezes; 50 apostas na mesma wallet com zero 503 e zero `40P01`; sanidade do lock (transação externa segura o `FOR UPDATE`, duas requisições bloqueiam e completam depois)

## Fatia 4b: reversões e PENDING_REFERENCE (concluída)

Decisões em ARCHITECTURE.md, seções 5.10 e 5.11.

- [x] Remover o 501; hash calculado antes de tudo
- [x] Regras compartilhadas (`wager-rules.ts`): referência resolvida sob o lock da wallet, `ALREADY_REVERSED` antes do INSERT, `AMOUNT_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REVERSAL_WOULD_OVERDRAW`
- [x] Ausente, PENDING ou PENDING_REFERENCE → grava `PENDING_REFERENCE`, 202 e `WagerTransactionPendingReference`; o replay reflete o estado atual
- [x] Reversão rejeitada guarda `reference_transaction_id` (auditoria)
- [x] WIN e LOSS com referência: informativos
- [x] `ResolvePendingReference`: lê sem lock → trava a wallet → relê → no-op se já não está pendente; UPDATE com guarda de status e conferência de linhas
- [x] Testes: cada regra, replay, reversão antes da referência, dupla reversão concorrente, resolves concorrentes, REFUND e BET em paralelo

## Fatia 6: publisher da outbox (concluída)

Decisões em ARCHITECTURE.md, seção 6 (e 5.5 para o pool).

- [x] Fila FIFO `wager-events.fifo` com DLQ no LocalStack; `@aws-sdk/client-sqs` com `maxAttempts: 1`
- [x] Teste de fumaça: o LocalStack deduplica por `MessageDeduplicationId`, então os testes exigem cada `eventId` exatamente uma vez
- [x] `PublishOutboxBatch`: claim com `SKIP LOCKED` → `SendMessageBatch` com timeout → `published_at` ou retry, numa transação
- [x] `idle_in_transaction_session_timeout` ≥ `max(3 × envio, 15 s)`, validado na configuração
- [x] Falha por entrada: erro do remetente (log `error` + contador próprio) × erro do serviço; timeout tratado como ambíguo
- [x] Worker por instância; o shutdown (`app.close()`/SIGTERM) conclui o lote em andamento
- [x] Métrica `outbox_lag_seconds` e contadores (porta `Metrics`, em memória até a fatia 9)
- [x] Correção: conexão derrubada pelo servidor vazava a vaga do pool (Kysely); timestamps das consultas cruas viravam string
- [x] Testes: next_attempt_at do Clock, atributos da mensagem, SQS fora do ar, timeout, idle timeout (controle e envio lento), reinício, shutdown, 3 publishers, crash com `Bun.spawn`, recuperação do pool

## Fatia 7: consumidor SQS de wager-transactions.fifo (concluída)

Decisões em ARCHITECTURE.md, seção 7. Os dois lembretes antigos desta fatia (ordem por `walletVersion` e inbox por `eventId`) valem para quem consome `wager-events.fifo` e viraram contrato em ARCHITECTURE 6.4.

- [x] Inbox no use case: `ON CONFLICT ON CONSTRAINT inbox_pk DO NOTHING` antes do lock; hash da inbox = key + negócio; `INBOX_MESSAGE_CONFLICT`
- [x] Parsing do envelope com o validador do HTTP; classificação permanente × transitória × inesperada
- [x] Adaptador SQS, worker (long polling, grupos, DLQ explícita, backoff, shutdown), configuração e métricas
- [x] Redrive de `wager-transactions.fifo` em 15 (3 × 5), conferido no boot
- [x] Testes: 10 entregas, messageId novo (replay), HTTP → SQS, venenosas, lock timeout, limite de tentativas com seguidora, REFUND antes da BET, shutdown, crash entre commit e ack
- [x] Teste de estresse multi-processo (3 consumidores, grupo por mensagem) e mesmo messageId concorrente

## Fatia 9 (observações herdadas da fatia 6)
- [ ] `PublishOutboxBatch`: os contadores (`outbox_published_total` e retries) são incrementados antes do commit do lote; se o commit falhar, a métrica conta envios que serão refeitos. Mover para depois do commit
- [ ] Índice parcial `(occurred_at) WHERE published_at IS NULL` para o `min(occurred_at)` da métrica de outbox lag, que hoje percorre todas as pendentes
- [ ] ARCHITECTURE: retenção das linhas publicadas da outbox e da inbox (limpeza periódica); relógio (o `Clock` de cada instância grava `next_attempt_at`, e uma instância com relógio adiantado antecipa retries); evento envenenado (erro do remetente fica em retry para sempre, só com alerta)

## Fatia 8 (lembrete para o worker)
- [ ] Respeitar a ordem de locks de 5.11: nunca travar `wager_transactions` antes da wallet
- [ ] Limite de tentativas ou TTL → `REJECTED` `REFERENCE_NOT_FOUND` + evento (também encerra ROLLBACK de OPENING e referências de outro provider)
