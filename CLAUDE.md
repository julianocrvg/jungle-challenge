# CLAUDE.md — Distributed Wagering Processor

Desafio técnico da Jungle Gaming. O enunciado completo está em `docs/challenge.md` (fonte da verdade: leia antes de decidir qualquer coisa ambígua).

**Prazo:** terça-feira 23:59. Priorize pela tabela de pontos: correção financeira (20), concorrência (20), idempotência (15), mensageria e falhas (15), modelagem (10), testes (10), observabilidade (5), documentação (5). Autenticação NÃO vale ponto.

## Como trabalhar comigo

- Antes de implementar algo novo, proponha um plano curto e espere minha aprovação.
- Trabalhe em fatias pequenas e verticais. Cada fatia termina com testes passando e um commit.
- Explique em 2 a 4 linhas cada decisão não óbvia (lock, transação, constraint). Eu vou defender este código numa apresentação, então não escreva nada que eu não consiga explicar.
- Quando tomar uma decisão ou interpretação nova, adicione uma entrada em `ARCHITECTURE.md` na mesma fatia.
- Não adicione dependências sem me avisar e justificar.
- Se uma instrução do enunciado conflitar com algo que eu pedir, avise antes de seguir.

## Modelos e uso do limite

Eu uso o plano Pro, cujo limite é compartilhado e se esgota em janelas de 5 horas. Ajude-me a economizar:

- **Trabalho de rotina** (setup, boilerplate NestJS, migrations simples, controllers, testes unitários, README): rode no Sonnet 5.5, que consome o plano mais devagar.
- **Partes críticas**, onde um erro é eliminatório: sugira que eu troque para o Opus 5.5 (`/model`) antes de começar. São elas:
  - o use case principal de submissão (lock, idempotência e outbox na mesma transação)
  - o schema, as constraints e o trigger do ledger
  - o publisher da outbox e o consumidor SQS (inbox, ack, DLQ, shutdown)
  - depuração de testes de concorrência intermitentes
  - a revisão final contra a lista de restrições invioláveis
- Se `opusplan` estiver disponível, ele serve bem para planejar no Opus e executar no Sonnet.
- Para as partes críticas no Sonnet, sugira subir o esforço (`--effort high`).
- Avise-me quando uma fatia terminar para eu rodar `/clear` antes da próxima. Conversas longas consomem mais limite.
- Peça só os arquivos e trechos necessários; evite reler o repositório inteiro a cada pedido.
- Se eu estiver perto do limite da janela, priorize terminar a fatia atual, deixar tudo commitado e anotar o próximo passo em `ARCHITECTURE.md` ou em um `TODO.md`.

## Stack (obrigatória)

- Bun 1.x (runtime, package manager e test runner: `bun test`)
- TypeScript em modo estrito
- NestJS
- PostgreSQL
- AWS SQS via LocalStack (filas FIFO: `wager-transactions.fifo` e `wager-transactions-dlq.fifo`)
- Docker Compose para orquestração local
- ORM: MikroORM (preferencial). Prisma é proibido.
- Migrations versionadas e reversíveis (`up` e `down` funcionais)

## Restrições invioláveis (falhas eliminatórias)

Nunca viole nenhuma destas, nem em testes:

1. Proibido `number`, `float` ou `double` para dinheiro. Nada de `parseFloat`, `Number()` ou `toFixed` em valores monetários.
2. Idempotência NUNCA em memória. Quem decide é a constraint UNIQUE do banco, não um `SELECT` antes do `INSERT`.
3. Não confiar só no SQS FIFO para consistência. O banco garante as invariantes.
4. Nunca publicar evento antes do commit da transação financeira.
5. Ledger é imutável: sem UPDATE e sem DELETE em lançamentos.
6. Sem lock global. A unidade de concorrência é a `walletId` (lock por linha).
7. Proibido saldo como read → calculate → update sem controle de concorrência.
8. Tem de funcionar corretamente com 3 ou mais instâncias simultâneas.
9. Unicidade, imutabilidade e não-negatividade valem no schema do banco, não só no código.
10. Testes de integração usam PostgreSQL e LocalStack reais. Não substitua o banco ou o SQS por mocks.

## Decisões de arquitetura já tomadas

**Concorrência:** `SELECT ... FOR UPDATE` na linha da wallet dentro da transação. `version` como defesa extra (`UPDATE ... WHERE version = ?`). `version` começa em 1 e só incrementa quando o saldo muda. Wallet criada com saldo inicial > 0 já nasce com o saldo e `version = 1`, e o lançamento OPENING fica em `wallet_version = 1` (`Wallet.openWithBalance`).

**Fluxo do use case de submissão (uma única transação SQL):**
1. Se vier do SQS, inserir na inbox (`ON CONFLICT DO NOTHING`). Se já existia, é duplicata.
2. Travar a wallet com `FOR UPDATE` **antes** de inserir a transação. Zero linhas: `WALLET_NOT_FOUND`, nada é gravado. (Inserir antes faria a FK pegar `FOR KEY SHARE` na wallet, e duas requisições concorrentes entrariam em deadlock `40P01` ao pedir `FOR UPDATE`; ver ARCHITECTURE 5.1.)
3. Inserir `wager_transaction` com `ON CONFLICT (idempotency_key) DO NOTHING`. Se conflitou, carregar a existente e comparar `payloadHash`: igual é replay, diferente é conflito.
4. Resolver a referência (REFUND e ROLLBACK). Ausente leva a `PENDING_REFERENCE`.
5. Aplicar a regra de negócio, atualizar saldo e `version`, gravar o lançamento no ledger.
6. Gravar eventos na outbox.
7. Commit. Só depois: ack do SQS e qualquer publicação.

O mesmo use case atende HTTP e SQS.

**Idempotência:** header `Idempotency-Key` obrigatório (default `{providerId}:{externalTransactionId}`). `payloadHash` = SHA-256 de JSON canônico (chaves ordenadas) apenas dos campos de negócio; header e metadados de transporte ficam fora. Replay devolve a resposta original, incluindo o saldo observado na época (guardar `balance_after` na transação, inclusive para LOSS e REJECTED).

**Money:** `amount` como string decimal com escala fixa de 2, validada por regex estrita. Internamente `decimal.js` ou bigint em centavos. Persistência: `NUMERIC(19,2)` mais coluna `currency` separada, via custom type do MikroORM. O domínio não depende do ORM nem do NestJS. O modelo é multi-moeda mesmo usando só BRL, e conflito de moeda é testado.

**Schema (aplicado no banco):**
- `wallets`: `UNIQUE(player_id, currency)`, `CHECK(balance >= 0)`
- `wager_transactions`: `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, `CHECK` de referência obrigatória para REFUND e ROLLBACK, índice único parcial em `(reference_transaction_id)` contra dupla reversão
- `wallet_ledger_entries`: `UNIQUE(wallet_id, transaction_id)` e trigger que bloqueia UPDATE e DELETE
- `inbox`: PK `(consumer_name, message_id)`
- `outbox`: índice parcial em `(next_attempt_at) WHERE published_at IS NULL`

**Outbox:** vários publishers concorrentes com `SELECT ... FOR UPDATE SKIP LOCKED`. Publicar, depois marcar `published_at`. Falha agenda retry com backoff. `eventId` como deduplication id. O consumidor tolera duplicata.

**PENDING_REFERENCE:** worker agendado com `SKIP LOCKED`, `attempts` e backoff exponencial. Limite de tentativas ou TTL definido e justificado em `ARCHITECTURE.md`. Esgotado: `REJECTED` com `REFERENCE_NOT_FOUND` e evento publicado.

**SQS:** `MessageGroupId = walletId` é só otimização. Erros de negócio: ack. Transitórios: retry com backoff. Permanentes: DLQ. Em SIGTERM: parar o polling e concluir as mensagens em andamento.

## Regras de domínio (resumo)

- Modelagem: construtor `private`, factories estáticas (`create`, `from`, `rehydrate`). `rehydrate` não revalida transições.
- Fluxos: BET leva a WIN, LOSS, REFUND ou ROLLBACK. `OPENING` é interno e nunca entra pela API nem pela fila.
- BET: débito, rejeita se saldo insuficiente. WIN e REFUND: crédito. LOSS: sem efeito no saldo e sem ledger. ROLLBACK: inverso da referência.
- REFUND só referencia BET. ROLLBACK referencia BET, WIN ou REFUND. Ambos exigem `referenceExternalTransactionId`, resolvido por `(providerId, referenceExternalTransactionId)`, que deve ter o mesmo provider, player, wallet, moeda e rodada. O valor deve ser igual ao da referência. Uma referência só pode ser revertida uma vez no total, por qualquer tipo (REFUND ou ROLLBACK; interpretação mais estrita que o enunciado, ver ARCHITECTURE.md 2.4).
- `PROCESSED`, `REJECTED` e `FAILED` são terminais. Transicionar um terminal lança `InvalidTransactionStateError`.
- REJECTED não altera saldo nem gera ledger, mas é persistida e idempotente.
- Reversão que causaria saldo negativo: `REVERSAL_WOULD_OVERDRAW`, distinto de `INSUFFICIENT_FUNDS`.
- Taxonomia mínima de `failureCode`: `INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_MISMATCH`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `CURRENCY_MISMATCH`, `INVALID_REFERENCE_KIND`, `PLAYER_MISMATCH`.
- Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda), `WagerTransactionPendingReference`. `data` carrega `MoneyProps` (string), nunca a instância de `Money`.

## Mapeamento HTTP (consistente em todos os endpoints)

- 400: payload inválido
- 404: recurso inexistente (WALLET_NOT_FOUND, transação não encontrada). Não persiste nada; no SQS, wallet inexistente é erro permanente e vai para a DLQ.
- 409: conflito de idempotência (mesma key, payload diferente) e wallet duplicada
- 422: rejeição por regra de negócio (com `failureCode`)
- 202: aceito com processamento pendente (`PENDING_REFERENCE`)
- 503 (com `Retry-After`): falha transitória de infraestrutura

## Autenticação

Não implementar. Criar um `AuthGuard` no-op e um ponto de extensão explícito. Documentar em `ARCHITECTURE.md` o desenho que adotaria (IdP externo como Keycloak ou Zitadel, OIDC/JWT, `providerId` derivado do token). Endpoints de health ficam abertos.

## Testes

- Unidade: Money, invariantes da Wallet, regras por tipo de operação, conflito de moeda, key com payload divergente.
- Integração (containers reais): migrations e constraints (tentar violá-las), atomicidade wallet, ledger, inbox e outbox, redelivery, publishers concorrentes, retry e DLQ, recuperação após reinício.
- Concorrência (paralelismo real com `Promise.all` e processos separados via `Bun.spawn`, nunca mocks sequenciais): mesma aposta 50 vezes em paralelo gera um débito; duas apostas de 80 sobre saldo 100 geram exatamente uma PROCESSED, uma REJECTED, saldo 20.00 e um lançamento; wallets distintas em paralelo; 3 ou mais instâncias; crash entre commit e ack; dois publishers; reversão antes da referência; reinício com consistência final.
- **Todo teste de integração e concorrência termina verificando: `wallet.balance == saldo reconstruído pelo ledger`.**
- Testes devem ser determinísticos. Sem `sleep` arbitrário; use polling com timeout.

## Observabilidade

Logs JSON estruturados com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Sem payload financeiro completo nem dados sensíveis. Métricas mínimas: transações por status, duplicatas, retries, mensagens na DLQ, conflitos de lock, outbox lag, latência. `/health/live` e `/health/ready` (Postgres e SQS), sem autenticação.

## Comandos

```bash
docker compose up -d          # Postgres (host:5433) e LocalStack (4566, filas criadas no boot)
bun install
bun run migration:up          # aplicar migrations
bun run migration:down        # reverter a última
bun run start:dev             # subir a API (PORT, default 3000)
bun run typecheck             # tsc --noEmit
bun test                      # todos os testes
bun test test/integration     # só uma pasta/arquivo (filtro por caminho)
bun test -t "<nome do teste>" # filtro por nome do teste
```

Postgres na porta 5433 porque há um PostgreSQL local na 5432. Testes usam o banco `wagering_test` (`TEST_DATABASE_URL`).

Variáveis do banco: `DATABASE_URL`, `DB_POOL_MAX` (default 20) e `DB_LOCK_TIMEOUT_MS` (default 10000, ARCHITECTURE 5.5).

Variáveis do SQS: `SQS_ENDPOINT` (default `http://localhost:4566`), `AWS_REGION`, `SQS_EVENTS_QUEUE_URL` (default `wager-events.fifo`).
Publisher da outbox (ARCHITECTURE 6): `OUTBOX_PUBLISHER_ENABLED` (default true), `OUTBOX_BATCH_SIZE` (default 10, máx. 10), `OUTBOX_POLL_INTERVAL_MS` (500), `OUTBOX_SEND_TIMEOUT_MS` (5000), `OUTBOX_IDLE_TX_TIMEOUT_MS` (default e mínimo `max(3 × send, 15000)`).
Consumidor de `wager-transactions.fifo` (ARCHITECTURE 7): `SQS_CONSUMER_ENABLED` (default true), `SQS_TRANSACTIONS_QUEUE_URL`, `SQS_TRANSACTIONS_DLQ_URL`, `SQS_CONSUMER_MAX_ATTEMPTS` (5; o redrive da fila precisa ser ≥ 3×), `SQS_CONSUMER_WAIT_SECONDS` (20), `SQS_CONSUMER_VISIBILITY_TIMEOUT_S` (30, ≥ lock_timeout + 5 s), `SQS_CONSUMER_CONCURRENCY` (10), `SQS_CONSUMER_BACKOFF_BASE_MS` (1000), `SQS_CONSUMER_BACKOFF_MAX_MS` (60000).
Worker de PENDING_REFERENCE (ARCHITECTURE 8): `PENDING_REFERENCE_WORKER_ENABLED` (default true), `PENDING_REFERENCE_POLL_INTERVAL_MS` (1000), `PENDING_REFERENCE_BATCH_SIZE` (50), `PENDING_REFERENCE_CONCURRENCY` (4), `PENDING_REFERENCE_TTL_MS` (3600000), `PENDING_REFERENCE_MAX_ATTEMPTS` (30), `PENDING_REFERENCE_BACKOFF_BASE_MS` (1000), `PENDING_REFERENCE_BACKOFF_MAX_MS` (300000).
Orçamento do pool (ARCHITECTURE 8.5): consumidor + publisher (1) + worker de pendentes ≤ `DB_POOL_MAX` − 5, validado no boot.
Depois de mudar `docker/localstack/init-sqs.sh`: `docker compose up -d --force-recreate localstack`.

Ajuste os scripts reais em `package.json` e mantenha esta seção atualizada.

## Ordem de implementação

1. Setup (Bun, NestJS, Docker Compose, MikroORM, migrations)
2. Domínio puro com testes unitários
3. Schema e constraints com testes de integração
4. Submissão via HTTP com idempotência e o cenário das 2 apostas
5. Consultas, ledger paginado por cursor opaco e reconciliação
6. Outbox e publisher
7. Consumidor SQS (inbox, DLQ, shutdown)
8. Worker de PENDING_REFERENCE
9. Observabilidade
10. Testes de concorrência multi-processo
11. README e ARCHITECTURE

Se faltar tempo, corte nesta ordem: `test:load`, double-entry, auth real, OpenTelemetry. Nunca corte testes de concorrência, atomicidade com a outbox, `ARCHITECTURE.md` nem a revisão final.

## Ambiente (Windows 11 + VS Code)

- Docker Desktop com backend WSL2.
- Mantenha line endings LF (`.gitattributes` com `* text=auto eol=lf`) para não quebrar scripts e migrations.
- Prefira caminhos relativos e scripts que funcionem em PowerShell e em WSL.
- Em testes multi-processo, use `Bun.spawn` com portas distintas e encerre os processos filhos no `afterAll`.

## Definição de pronto (checklist final)

- [ ] Nenhuma restrição inviolável quebrada (revisar a lista acima)
- [ ] Constraints e trigger do ledger no schema, com teste que tenta violá-los
- [ ] Cenário obrigatório (2 apostas de 80 sobre 100) passando contra Postgres real
- [ ] Testes de concorrência com 3 ou mais instâncias passando
- [ ] `balance == soma do ledger` verificado em todos os testes finais
- [ ] README (setup e comandos) e ARCHITECTURE (decisões, trade-offs, limitações, taxonomia de erros, mapeamento HTTP, decisão sobre auth)
