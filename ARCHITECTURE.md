# ARCHITECTURE

Registro das decisões técnicas, na ordem em que foram tomadas. Cada entrada diz o que foi decidido e por quê.

## 1. Setup

### 1.1 Versões
Bun 1.4, NestJS 12, MikroORM 7 (`@mikro-orm/postgresql`), PostgreSQL 16 e LocalStack 3.8 (só SQS). A imagem do LocalStack está fixada numa tag para que o ambiente seja reproduzível.

### 1.2 Mapeamento ORM: `EntitySchema` e mappers finos
O domínio (`src/domain`) é TypeScript puro, sem decorators do ORM nem do NestJS. A persistência usa `EntitySchema` explícito e mappers `toDomain`/`toPersistence`, e reidrata o estado via `rehydrate`. Os comandos críticos usam SQL cru dentro de `em.transactional()`: `INSERT ... ON CONFLICT DO NOTHING`, `SELECT ... FOR UPDATE`, `UPDATE ... WHERE version = ?`. O motivo é deixar visível no código cada lock e cada constraint de que a correção depende, sem esconder isso atrás do Unit of Work.

### 1.3 Migrations
O SQL é escrito à mão em `this.addSql()`, porque o gerador do ORM não produz índices parciais, CHECKs compostos nem triggers. As migrations vão numa lista explícita (`migrationsList`) em vez de descoberta por glob, o que dá ordem determinística e funciona com Bun sem ts-node. Cada migration roda numa transação (`transactional`, `allOrNothing`). `bun run migration:down` reverte a última, e o teste de integração faz `down` até zero e depois `up` para provar a reversibilidade.

### 1.4 Ids: `IdGenerator` com `Bun.randomUUIDv7()`
Os ids são UUIDv7, gerados pela aplicação através da porta `IdGenerator`, e a implementação usa `Bun.randomUUIDv7()`. Assim não entra a dependência `uuid`. O v7 é ordenado por tempo, o que reduz a fragmentação do índice B-tree em inserts concorrentes. A porta permite usar um gerador determinístico em testes.

### 1.5 Portas locais
O Postgres do container sai na porta **5433** do host, para não colidir com um PostgreSQL instalado localmente na 5432. Existe um banco separado, `wagering_test`, criado em `docker/postgres/init.sql`, para os testes de integração.

## 2. Schema

Todas as garantias de unicidade, não-negatividade e imutabilidade estão no banco (restrição 9). O teste `test/integration/schema-constraints.test.ts` tenta violar cada uma e exige que o erro cite a constraint pelo nome.

### 2.1 Dinheiro
As colunas de valor são `NUMERIC(19,2)`, com `currency CHAR(3)` separada e validada por `CHECK (currency ~ '^[A-Z]{3}$')`. A representação é decimal exata, e o valor sempre sai do banco como string.

### 2.2 Enums como `TEXT + CHECK`
Usei `TEXT + CHECK` em vez de `CREATE TYPE`. Acrescentar um valor vira só trocar a constraint numa migration, que é reversível; com `ALTER TYPE ... ADD VALUE` não existe `down` simples.

### 2.3 `wallets`
- `UNIQUE (player_id, currency)`: uma wallet por player e moeda.
- `CHECK (balance >= 0)`: última linha de defesa contra saldo negativo, mesmo com bug na aplicação.
- `UNIQUE (id, currency)` existe só para ser alvo da FK composta do ledger (2.5).

### 2.4 `wager_transactions`
- `UNIQUE (idempotency_key)` é quem decide a idempotência. O use case faz `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` e, se nada for inserido, compara o `payload_hash` da linha existente.
- `UNIQUE (provider_id, external_transaction_id)` impede que o mesmo id do provedor entre com outra key. É também a chave de resolução de referências.
- `wt_amount_valid`: `amount > 0`; **zero só para `LOSS`**, que registra o resultado da rodada sem mover saldo.
- `wt_reference_by_kind`: REFUND e ROLLBACK exigem `reference_external_transaction_id`. OPENING e BET não podem ter referência. Em WIN e LOSS ela é opcional (o enunciado diz que o WIN "pode referenciar a BET").
- `wt_processed_reversal_resolved`: uma reversão `PROCESSED` precisa ter `reference_transaction_id`, o id interno já resolvido.
- `wt_failure_code_status`: `failure_code` existe exatamente em `REJECTED` e `FAILED`.
- `wt_terminal_processed_at`: `processed_at` é preenchido se e somente se o status é terminal.
- `wt_balance_after_terminal`: `PROCESSED` e `REJECTED` guardam `balance_after`, o saldo observado naquele momento, para que o replay devolva a resposta original.
- `round_id` e `game_id` são obrigatórios, exceto em `OPENING`, que é interno e não pertence a uma rodada.
- `attempts` e `next_attempt_at` servem ao worker de `PENDING_REFERENCE`, que usa o índice parcial `wt_pending_reference_due_idx`.

**Dupla reversão (`wt_single_reversal_uq`):** é um índice único parcial em `(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`. **Interpretação adotada:** uma referência só pode ser revertida **uma vez no total, por qualquer tipo**. Reverter a mesma BET com um REFUND e depois com um ROLLBACK (ou o contrário) creditaria o jogador duas vezes pelo mesmo débito; a regra 7.4 do enunciado ("pelo mesmo tipo") foi lida de forma mais estrita por segurança financeira. Duas instâncias que tentem reverter a mesma referência em paralelo esbarram no índice no commit, e só uma vence. O filtro em `PROCESSED` deixa uma reversão `REJECTED` (por exemplo, `REVERSAL_WOULD_OVERDRAW`) auditável sem bloquear uma tentativa legítima posterior. A mudança veio na migration `…0002` (o índice inicial era `(reference_transaction_id, kind)`).

**Ordem obrigatória no use case:** (1) travar a wallet com `FOR UPDATE` **antes** de avaliar qualquer regra; (2) sob o lock, checar se a referência já foi revertida (`ALREADY_REVERSED`) **antes** de inserir ou marcar a reversão como `PROCESSED`. O índice é a rede de proteção final, não o caminho normal: se o use case dependesse dele, a violação abortaria a transação em vez de produzir uma rejeição auditável.

### 2.5 `wallet_ledger_entries`
- `UNIQUE (wallet_id, transaction_id)`: no máximo um lançamento por transação.
- `wallet_version` guarda a versão da wallet **depois** do lançamento, com `UNIQUE (wallet_id, wallet_version)`. Como `version` só incrementa quando o saldo muda, cada versão corresponde a exatamente um lançamento, e um lost update aparece como violação de unicidade. Essa coluna é também a chave do cursor de paginação do ledger: estável, monotônica por wallet e sem empate (melhor que `created_at`). Uma wallet aberta com saldo zero fica na versão 1 sem lançamento; o primeiro crédito gera a versão 2.
- `ledger_arithmetic`: `balance_after = balance_before ± amount`, conforme `direction`. O banco recusa um lançamento que não fecha.
- FK `(wallet_id, currency) → wallets (id, currency)`: o lançamento tem a moeda da wallet.
- FK `(transaction_id, wallet_id) → wager_transactions (id, wallet_id)`: lançamento e transação apontam para a mesma wallet.
- **Imutabilidade:** triggers `BEFORE UPDATE OR DELETE` (por linha) e `BEFORE TRUNCATE` (por statement) chamam `wallet_ledger_entries_forbid_mutation()`, que lança `restrict_violation`. Vale também para o owner da tabela. Por isso os testes não limpam o ledger: o schema é recriado com `down`/`up`.

### 2.6 `inbox` e `outbox`
- `inbox`: PK `(consumer_name, message_id)`. O consumidor faz `INSERT ... ON CONFLICT DO NOTHING RETURNING`, e zero linhas significa duplicata.
- `outbox`: `id` é o `eventId` e serve de deduplication id no SQS. `next_attempt_at` é `NOT NULL DEFAULT now()`, e não opcional como no esqueleto do enunciado, para que a busca do publisher seja uma comparação simples sobre o índice parcial `outbox_pending_idx (next_attempt_at) WHERE published_at IS NULL`.

### 2.7 Wallet inexistente: não persistir
Uma transação para uma `walletId` que não existe **não é persistida**. A FK `wager_transactions.wallet_id` impediria o insert de qualquer forma, e não há linha para travar nem saldo para registrar em `balance_after`. Também não há efeito financeiro a deduplicar: um reenvio depois que a wallet existir é processado normalmente. Tratamento decidido (consta no mapeamento HTTP do CLAUDE.md, linha 404):
- **HTTP:** `404 WALLET_NOT_FOUND`, sem gravar nada. O mesmo 404 vale para consultas de transação inexistente.
- **SQS:** erro permanente, a mensagem vai para a DLQ em vez de receber ack. Como não há registro no banco, a DLQ é o único rastro auditável da mensagem.

`WALLET_NOT_FOUND` não entra no `CHECK` de `failure_code`, porque nunca é gravado.

## 3. Taxonomia de `failure_code` (persistida)

| Código | Status | Significado |
|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo |
| `REVERSAL_WOULD_OVERDRAW` | REJECTED | reversão deixaria o saldo negativo |
| `REFERENCE_NOT_FOUND` | REJECTED | referência não apareceu dentro do limite de tentativas |
| `REFERENCE_NOT_PROCESSED` | REJECTED | a referência existe, mas terminou `REJECTED` ou `FAILED`: não há efeito a reverter |
| `REFERENCE_MISMATCH` | REJECTED | referência de outro player, wallet, moeda ou rodada |
| `ALREADY_REVERSED` | REJECTED | referência já revertida (por REFUND ou ROLLBACK) |
| `AMOUNT_MISMATCH` | REJECTED | valor diferente do da referência |
| `CURRENCY_MISMATCH` | REJECTED | moeda da operação diferente da wallet |
| `INVALID_REFERENCE_KIND` | REJECTED | REFUND sobre algo que não é BET, ou ROLLBACK sobre algo que não é BET, WIN ou REFUND |
| `INTERNAL_ERROR` | FAILED | erro permanente de infraestrutura, terminal e auditável |
