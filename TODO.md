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

## Fatia 8 (lembrete para o worker)
- [ ] Respeitar a ordem de locks de 5.11: nunca travar `wager_transactions` antes da wallet
- [ ] Limite de tentativas ou TTL → `REJECTED` `REFERENCE_NOT_FOUND` + evento (também encerra ROLLBACK de OPENING e referências de outro provider)
