# Distributed Wagering Processor

Processador de transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) sobre carteiras, com ledger imutável, idempotência decidida pelo banco, outbox transacional e consumo de SQS. Desafio técnico da Jungle Gaming (enunciado em [docs/challenge.md](docs/challenge.md)).

Stack: Bun, TypeScript estrito, NestJS, MikroORM, PostgreSQL 16 e AWS SQS (FIFO) via LocalStack. As decisões e os trade-offs estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

| Ferramenta | Versão usada | Observação |
|---|---|---|
| [Bun](https://bun.sh) | 1.4.x | runtime, gerenciador de pacotes e test runner |
| Docker com Compose v2 | 29.x | no Windows, Docker Desktop com backend WSL2 |

Não é preciso instalar Node, PostgreSQL nem AWS CLI. O repositório usa line endings LF (`.gitattributes`).

## Subir a infraestrutura

```bash
docker compose up -d
```

| Serviço | Porta no host | Detalhe |
|---|---|---|
| PostgreSQL 16 | **5433** (não 5432, para não colidir com um PostgreSQL local) | usuário/senha/banco `wagering`; o banco `wagering_test` dos testes é criado no primeiro boot |
| LocalStack 3.8 (só SQS) | 4566 | cria as filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo` e `wager-events-dlq.fifo` |

O `docker compose up -d` retorna antes de tudo estar pronto; `docker compose ps` mostra `healthy` nos dois quando terminar. Depois de alterar `docker/localstack/init-sqs.sh`: `docker compose up -d --force-recreate localstack`.

**Portas:** o compose ocupa **5433** (PostgreSQL) e **4566** (LocalStack), e a API usa a **3000**. Se já houver outra stack ou outro clone no ar, suba um de cada vez (`docker compose down`, sem `-v`, no outro) ou o `up` falha por porta em uso.

## Instalar e migrar

```bash
bun install
cp .env.example .env        # opcional: os defaults do código já apontam para o compose
bun run migration:up        # aplica as migrations no banco `wagering`
bun run migration:down      # reverte a última
```

As migrations são SQL escrito à mão, versionadas e reversíveis (`up` e `down`).

## Variáveis de ambiente

Todas são opcionais; o default é o valor de desenvolvimento. O arquivo [.env.example](.env.example) lista todas com os defaults (o Bun carrega `.env` sozinho). Valor inválido (por exemplo, inteiro não positivo) derruba o boot com mensagem clara.

| Variável | Default | Função |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `INSTANCE_ID` | `host-pid` | identifica a instância no header `X-Instance-Id` e nos logs |
| `LOG_LEVEL` | `info` | `debug` inclui a linha de requisição de `/health/*` e `/metrics` |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5433/wagering` | banco da aplicação |
| `TEST_DATABASE_URL` | `postgres://wagering:wagering@localhost:5433/wagering_test` | banco dos testes de integração |
| `DB_POOL_MAX` | `20` | conexões do pool |
| `DB_LOCK_TIMEOUT_MS` | `10000` | `lock_timeout` de cada transação de escrita; estouro vira 503 |
| `SQS_ENDPOINT` | `http://localhost:4566` | endpoint do SQS (LocalStack) |
| `AWS_REGION` | `us-east-1` | região |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` / `test` | credenciais fictícias do LocalStack |
| `SQS_EVENTS_QUEUE_URL` | `<endpoint>/000000000000/wager-events.fifo` | destino da outbox |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publisher da outbox nesta instância |
| `OUTBOX_BATCH_SIZE` | `10` | mensagens por lote (máximo 10, limite do `SendMessageBatch`) |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | espera entre ticks com lote incompleto |
| `OUTBOX_SEND_TIMEOUT_MS` | `5000` | teto da chamada ao SQS |
| `OUTBOX_IDLE_TX_TIMEOUT_MS` | `max(3 × envio, 15000)` | `idle_in_transaction_session_timeout` do lote; valor menor é recusado |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor de `wager-transactions.fifo` |
| `SQS_TRANSACTIONS_QUEUE_URL` / `SQS_TRANSACTIONS_DLQ_URL` | `<endpoint>/000000000000/wager-transactions[-dlq].fifo` | fila de entrada e DLQ |
| `SQS_CONSUMER_MAX_ATTEMPTS` | `5` | tentativas antes da DLQ (o redrive da fila precisa ser ≥ 3×) |
| `SQS_CONSUMER_WAIT_SECONDS` | `20` | long polling (máximo 20) |
| `SQS_CONSUMER_VISIBILITY_TIMEOUT_S` | `30` | visibilidade; precisa ser ≥ `DB_LOCK_TIMEOUT_MS` + 5 s |
| `SQS_CONSUMER_CONCURRENCY` | `10` | mensagens em paralelo por instância |
| `SQS_CONSUMER_BACKOFF_BASE_MS` / `_MAX_MS` | `1000` / `60000` | backoff de falhas transitórias |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de reversões pendentes |
| `PENDING_REFERENCE_POLL_INTERVAL_MS` | `1000` | espera entre ciclos |
| `PENDING_REFERENCE_BATCH_SIZE` | `50` | pendentes vencidas por ciclo |
| `PENDING_REFERENCE_CONCURRENCY` | `4` | resolves em paralelo |
| `PENDING_REFERENCE_TTL_MS` | `3600000` | prazo máximo de espera pela referência (1 h) |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `30` | rede de segurança do prazo |
| `PENDING_REFERENCE_BACKOFF_BASE_MS` / `_MAX_MS` | `1000` / `300000` | backoff da espera |
| `LEDGER_DEFAULT_PAGE_SIZE` / `LEDGER_MAX_PAGE_SIZE` | `50` / `100` | paginação do ledger |

**Orçamento do pool:** consumidor + publisher (1) + worker de pendentes devem somar no máximo `DB_POOL_MAX − 5`; com os defaults, 10 + 1 + 4 = 15 = 20 − 5. A conta é validada no boot, e as 5 conexões restantes ficam para o HTTP.

## Rodar a aplicação

```bash
bun run start:dev      # com --watch
bun run start          # sem watch
```

Cada instância sobe a API, o publisher da outbox, o consumidor SQS e o worker de pendentes (cada um desligável por variável). Para **várias instâncias** contra o mesmo banco e as mesmas filas, use portas e ids distintos, um terminal por instância:

```bash
PORT=3000 INSTANCE_ID=a bun run start
PORT=3001 INSTANCE_ID=b bun run start
```

```powershell
$env:PORT=3001; $env:INSTANCE_ID='b'; bun run start
```

Não há lock global nem coordenação entre instâncias: a consistência vem do banco (ver [ARCHITECTURE.md](ARCHITECTURE.md)). Cada resposta traz `X-Instance-Id` e `X-Correlation-Id`.

## Exemplos

Os exemplos são `bash`; no Windows, use Git Bash ou WSL. Substitua `$P` (playerId) e `$W` (walletId) pelos UUIDs gerados.

**Criar a wallet** (saldo inicial opcionalmente zero):

```bash
P=$(bun -e 'console.log(crypto.randomUUID())')
curl -s -X POST localhost:3000/wallets -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$P\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
```
```
201 {"id":"<walletId>","playerId":"<playerId>","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

Uma segunda criação para o mesmo player e moeda dá `409 {"code":"WALLET_ALREADY_EXISTS", ...}`.

**BET com `Idempotency-Key`** (o header é obrigatório; valores monetários são sempre strings com 2 casas):

```bash
W=<walletId>
BET="{\"providerId\":\"acme\",\"externalTransactionId\":\"bet-1\",\"playerId\":\"$P\",\"walletId\":\"$W\",\"roundId\":\"round-1\",\"gameId\":\"slots\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
curl -s -X POST localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: acme:bet-1' -d "$BET"
```
```
200 {"transactionId":"<id>","status":"PROCESSED","failureCode":null,"balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false}
```

**Replay** (mesma key e mesmo payload): devolve a resposta original, com o saldo observado na época, e `idempotentReplay: true`. Nada é debitado de novo.

```
200 {"transactionId":"<mesmo id>","status":"PROCESSED","failureCode":null,"balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":true}
```

**Mesma key com payload diferente** (por exemplo, `amount` 10.00): conflito de idempotência.

```
409 {"code":"IDEMPOTENCY_KEY_CONFLICT","message":"Idempotency-Key was already used with a different payload"}
```

**Rejeição de negócio** (outra BET de 80.00 com saldo 20.00, key nova): persistida e idempotente.

```
422 {"transactionId":"<id>","status":"REJECTED","failureCode":"INSUFFICIENT_FUNDS","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false}
```

**REFUND** da BET (a referência é `referenceExternalTransactionId`, com o mesmo valor):

```bash
REF="{\"providerId\":\"acme\",\"externalTransactionId\":\"refund-1\",\"playerId\":\"$P\",\"walletId\":\"$W\",\"roundId\":\"round-1\",\"gameId\":\"slots\",\"kind\":\"REFUND\",\"referenceExternalTransactionId\":\"bet-1\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
curl -s -X POST localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: acme:refund-1' -d "$REF"
```
```
200 {"transactionId":"<id>","status":"PROCESSED","failureCode":null,"balance":{"amount":"100.00","currency":"BRL"},"idempotentReplay":false}
```

Se a referência ainda não existir, a reversão fica `PENDING_REFERENCE` (`202`, `balance: null`) e é resolvida pelo worker quando a BET chegar, ou rejeitada com `REFERENCE_NOT_FOUND` ao fim do prazo.

**Consultas e reconciliação:**

```bash
curl -s localhost:3000/wallets/$W
curl -s "localhost:3000/wallets/$W/ledger?limit=2"        # {"entries":[...],"nextCursor":"Mg"}; passe nextCursor em ?cursor=
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/acme/wagering/transactions/bet-1
curl -s -X POST localhost:3000/wallets/$W/reconciliation  # saldo guardado × soma do ledger
```
```
{"walletId":"<id>","storedBalance":{"amount":"100.00","currency":"BRL"},"calculatedBalance":{"amount":"100.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":3}
```

**Pela fila** (mesmo use case do HTTP). O envelope é `{messageId, type, occurredAt, data}`, com `type` `WagerTransactionRequested` e `data` igual ao corpo HTTP (`data.idempotencyKey` é opcional; sem ele vale `{providerId}:{externalTransactionId}`). `MessageGroupId` é a `walletId`:

```bash
docker compose exec -T localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id $W --message-deduplication-id msg-0001 \
  --message-body '{"messageId":"msg-0001","type":"WagerTransactionRequested","occurredAt":"2026-10-19T12:00:00.000Z","data":{...}}'
```

Mensagem inválida ou para wallet inexistente vai direto para `wager-transactions-dlq.fifo`, com `failureReason` nos atributos.

**Saúde e métricas** (abertos, sem autenticação):

```bash
curl -s localhost:3000/health/live     # {"status":"ok"}; não toca dependências
curl -s localhost:3000/health/ready    # 200 {"status":"ok","checks":{"postgres":"ok","sqs-events":"ok","sqs-transactions":"ok","sqs-transactions-dlq":"ok"}}; 503 se algum falhar
curl -s localhost:3000/metrics         # texto do Prometheus
```

`/metrics` não deve ser exposto publicamente. `outbox_lag_seconds` é global (o mesmo valor em toda instância): agregue com `max`.

### Códigos HTTP

| Código | Quando |
|---|---|
| 200 | transação `PROCESSED` (primeira vez ou replay) |
| 201 | wallet criada |
| 202 | reversão aceita, `PENDING_REFERENCE` |
| 400 | payload, header, cursor ou id inválido |
| 404 | wallet ou transação inexistente (nada é gravado) |
| 409 | `Idempotency-Key` com payload diferente, `externalTransactionId` com outra key, wallet duplicada |
| 422 | rejeição de negócio, com `failureCode` |
| 503 | falha transitória de infraestrutura (com `Retry-After`) |

## Testes

```bash
bun run typecheck             # tsc --noEmit
bun test                      # tudo (cerca de 2 minutos); exige o compose no ar
bun run test:unit             # sem infraestrutura, menos de 2 s
bun run test:integration      # Postgres e LocalStack reais
bun run test:multi-instance   # 3 processos reais da API (cerca de 1 minuto)
bun test -t "<nome do teste>" # filtro por nome
```

Parar a app local antes de `bun test` é uma recomendação, não uma exigência: verificado com a app ligada (`bun run start`), `bun test` e `test:multi-instance` passam, porque os testes usam o banco `wagering_test` e filas temporárias, e a app usa `wagering` e as filas do compose. Parar evita só ruído de CPU e de logs e deixa os tempos mais estáveis.

Os testes de integração usam PostgreSQL e LocalStack **reais** (nada de mocks de banco ou de SQS) e recriam o schema do banco `wagering_test`, sem tocar no banco da aplicação. Os de concorrência usam paralelismo real (`Promise.all` e processos separados via `Bun.spawn`). Todo teste de integração e de concorrência termina verificando `wallet.balance == saldo reconstruído pelo ledger`.

### Teste de carga (opcional)

```bash
bun run test:load             # contra a API já no ar em http://localhost:3000
LOAD_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003 LOAD_REPEATS=3 bun run test:load
```

Fora do `bun test`. **Usa o banco e as filas de desenvolvimento** (`wagering`, não `wagering_test`): cria wallets novas a cada execução, e os dados ficam lá. Não sobe nem derruba instâncias. Cenários `distinct-wallets`, `hot-wallet` e `mixed`; ao fim confere reconciliação, ledger e saldo e sai com código 1 se algo divergir. Relatório JSON em `load-results/` (fora do git). Variáveis, metodologia e resultados: ARCHITECTURE 16.

## Decisões e limitações

Resumo; os detalhes e as justificativas estão em [ARCHITECTURE.md](ARCHITECTURE.md).

- **Concorrência:** `SELECT ... FOR UPDATE` na linha da wallet, travada antes de qualquer INSERT (evita deadlock). Sem lock global; `version` como defesa extra.
- **Idempotência:** decidida pelas constraints `UNIQUE` do banco, nunca em memória. `payloadHash` SHA-256 do JSON canônico dos campos de negócio.
- **Dinheiro:** string decimal com 2 casas, `NUMERIC(19,2)` e `decimal.js`. Nenhum `number` toca valor monetário.
- **Ledger imutável** por trigger no banco; saldo nunca negativo por `CHECK`.
- **Mensageria:** outbox publicada só depois do commit; inbox, ack depois do commit, DLQ explícita e shutdown gracioso no consumidor.
- **Autenticação não implementada**, de propósito: há um `AuthGuard` no-op como ponto de extensão e o desenho de produção está documentado.
- **Limitações conhecidas:** retenção da outbox e da inbox não implementada; métricas em memória por instância; evento envenenado da outbox exige ação humana; a reversão pendente espera o próximo ciclo do worker; SIGTERM entre processos não é testado no Windows (o shutdown é testado por `app.close()`).
