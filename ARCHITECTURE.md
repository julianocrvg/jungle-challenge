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
- `wallet_version` guarda a versão da wallet **depois** do lançamento, com `UNIQUE (wallet_id, wallet_version)`. Como `version` só incrementa quando o saldo muda, cada versão corresponde a exatamente um lançamento, e um lost update aparece como violação de unicidade. Essa coluna é também a chave do cursor de paginação do ledger: estável, monotônica por wallet e sem empate (melhor que `created_at`). Uma wallet aberta com saldo zero fica na versão 1 sem lançamento. Aberta com saldo inicial, fica na versão 1 **com** o lançamento OPENING em `wallet_version = 1` (seção 4.2). Nos dois casos, o movimento seguinte gera a versão 2, e vale `version = COALESCE(MAX(wallet_version), 1)`.
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
| `REFERENCE_NOT_FOUND` | REJECTED | a referência não apareceu até o fim do prazo da espera (TTL ou limite de tentativas; seção 8.3) |
| `REFERENCE_NOT_PROCESSED` | REJECTED | referência **conhecida mas não aplicada**: terminou `REJECTED` ou `FAILED`, ou ainda estava pendente quando o prazo da reversão acabou (8.3). Não há efeito a reverter |
| `REFERENCE_MISMATCH` | REJECTED | referência de outro player, wallet, moeda ou rodada |
| `ALREADY_REVERSED` | REJECTED | referência já revertida (por REFUND ou ROLLBACK) |
| `AMOUNT_MISMATCH` | REJECTED | valor diferente do da referência |
| `CURRENCY_MISMATCH` | REJECTED | moeda da operação diferente da wallet |
| `INVALID_REFERENCE_KIND` | REJECTED | REFUND sobre algo que não é BET, ou ROLLBACK sobre algo que não é BET, WIN ou REFUND |
| `PLAYER_MISMATCH` | REJECTED | o `playerId` da transação não é o dono da wallet (seção 5.7, migration 0003) |
| `INTERNAL_ERROR` | FAILED | erro permanente de infraestrutura, terminal e auditável |

## 4. Domínio (`src/domain`)

Puro: só importa módulos relativos e `decimal.js`. Sem NestJS, MikroORM nem `node:`. Um teste (`purity.test.ts`) varre os imports e também proíbe `parseFloat`, `Number(` e `.toNumber(`. Construtores são `private`, e as instâncias nascem por `create`/`open`/`receive`/`enqueue` (validam) ou `rehydrate` (não valida nada).

### 4.1 Money
`Decimal` (clone isolado, precisão 40) com escala fixa de 2. `Money.from` aceita só `^(0|[1-9]\d{0,16})\.\d{2}$`: sem sinal, sem notação científica, sem zeros à esquerda, e no máximo 17 dígitos inteiros para caber em `NUMERIC(19,2)`. `subtract` e `negate` podem produzir negativos (para checar saldo), mas esses valores não voltam por `from`. Moedas diferentes lançam `CurrencyMismatchError`. O `toFixed(2)` usado na serialização é o do `Decimal` (exato), não o de `Number`.

### 4.2 Wallet: `debit` e `credit` devolvem o lançamento
A única porta de mudança de saldo é `apply`, que atualiza saldo, `version` e `updatedAt` e cria o `WalletLedgerEntry` na mesma chamada. Assim "toda alteração de saldo tem um lançamento" vale no código, além do banco. O lançamento carrega `walletVersion` (a versão **depois** do lançamento, coluna `wallet_version` do ledger). `at` e `entryId` entram por parâmetro: o domínio não lê relógio nem gera UUID. Valor zero ou negativo lança `InvalidAmountError`; débito acima do saldo lança `InsufficientFundsError`, sem alterar nada.

`Wallet.open` cria a wallet com saldo **zero** e `version` 1, sem lançamento. `Wallet.openWithBalance` cria a wallet **já com o saldo inicial** e `version` 1, e devolve junto o lançamento OPENING (CREDIT de `0.00` até o saldo, `walletVersion` 1), que vai para a transação `OPENING`. Assim `POST /wallets` responde `version: 1` com ou sem saldo inicial, como no esqueleto do enunciado, e a invariante "todo saldo tem lançamento" continua valendo. (Antes, o saldo inicial entrava por `credit` e a wallet nascia na versão 2; isso foi trocado porque expor `version: 2` numa wallet recém-criada é surpreendente para o cliente.)

O domínio não impede concorrência: quem chama deve ter travado a linha da wallet (`FOR UPDATE`) antes de ler o estado (seção 2.4).

### 4.3 WagerTransaction: estados e transições
```
PENDING           -> PENDING_REFERENCE | PROCESSED | REJECTED | FAILED
PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED: terminais (qualquer transição lança InvalidTransactionStateError)
```
- `create` rejeita `OPENING`; o crédito de abertura nasce em `WagerTransaction.opening` (provider `internal`, sem rodada/jogo, chave `internal:opening:{walletId}`).
- `markProcessed` e `reject` recebem o saldo observado (`balanceAfter`), que o schema exige em PROCESSED e REJECTED. `fail` não recebe saldo e sempre grava `INTERNAL_ERROR`.
- `markProcessed` de uma reversão exige o `referenceTransactionId` já resolvido (espelha `wt_processed_reversal_resolved`).
- PENDING_REFERENCE -> PENDING_REFERENCE não é transição. Um novo retry é `registerReferenceRetry(nextAttemptAt)`, que só conta a tentativa (`attempts`) e reagenda. Só REFUND e ROLLBACK entram em `PENDING_REFERENCE`.

### 4.4 `validateReference` (regras de referência no domínio)
Devolve `resolved`, `wait` ou `reject` com o `failureCode`. Ordem das checagens, da mais para a menos específica da identidade:
1. referência ausente: `wait`;
2. provider, player, wallet ou rodada diferentes: `REFERENCE_MISMATCH`;
3. tipo inválido (REFUND só sobre BET; ROLLBACK sobre BET, WIN ou REFUND): `INVALID_REFERENCE_KIND`;
4. moeda diferente: `CURRENCY_MISMATCH`; valor diferente: `AMOUNT_MISMATCH`;
5. status da referência: `PROCESSED` resolve; `PENDING` e `PENDING_REFERENCE` são tratadas como **ausentes** (`wait`: a dependente continua em `PENDING_REFERENCE`); `REJECTED` e `FAILED` dão `REFERENCE_NOT_PROCESSED`, porque não há efeito a reverter e esperar não adiantaria.

`ALREADY_REVERSED` **não** é decidido aqui: depende de outras linhas do banco e é checado pelo use case sob o lock da wallet (seção 2.4). A identidade é conferida antes do status de propósito: uma referência de outro player deve ser reportada como `REFERENCE_MISMATCH` mesmo que esteja REJECTED.

`ledgerDirectionFor(reference)`: BET debita; OPENING, WIN e REFUND creditam; ROLLBACK é o inverso da direção da referência; LOSS não tem lançamento. `failureCodeForOverdraw()`: BET sem saldo é `INSUFFICIENT_FUNDS`; reversão que estoura o saldo é `REVERSAL_WOULD_OVERDRAW`.

### 4.5 Eventos
`aggregateId` é sempre o `walletId`, a unidade de concorrência e de ordenação (mesmo valor do `MessageGroupId`); o `transactionId` vai em `data`. `data` só tem JSON (`MoneyProps`, datas em ISO), e `from(...)` exige o estado certo da transação (por exemplo, `WagerTransactionProcessed.from` só aceita PROCESSED). `WalletBalanceChanged` é um por lançamento.

### 4.6 Outbox, inbox e backoff
`OutboxMessage.enqueue` usa o `eventId` como `id` (deduplication id no SQS) e `occurredAt` como primeiro `nextAttemptAt` (não opcional, como no schema). `scheduleRetry` incrementa `attempts` e agenda `now + min(1s · 2^(attempts-1), 5min)`. O backoff não tem jitter no domínio, para ser determinístico; jitter, se for preciso, fica na infraestrutura.

## 5. Use case de submissão

### 5.1 Ordem de locks: wallet `FOR UPDATE` antes do INSERT da transação
A ordem dentro da transação SQL é: inbox (se vier do SQS) → `SELECT ... FOR UPDATE` na wallet → `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` da `wager_transaction` → regras, ledger e `UPDATE ... WHERE version = ?` → outbox → commit.

**Por que travar antes de inserir:** o INSERT em `wager_transactions` valida a FK `wallet_id` e, para isso, o Postgres pega `FOR KEY SHARE` na linha da wallet. `FOR KEY SHARE` é compatível com outro `FOR KEY SHARE`, mas **não** com `FOR UPDATE`. Se a ordem fosse inserir e depois travar, duas requisições na mesma wallet fariam: A insere (KEY SHARE), B insere (KEY SHARE), A pede `FOR UPDATE` e espera B, B pede `FOR UPDATE` e espera A. O Postgres detecta o ciclo e aborta uma delas com `40P01` (deadlock). Travando primeiro, a segunda requisição simplesmente espera na fila do `FOR UPDATE`; depois disso, os inserts de transação, ledger e outbox pedem KEY SHARE numa linha que a própria transação já tem em `FOR UPDATE`, o que nunca bloqueia.

**Consequências:**
- Wallet inexistente aparece no passo do lock (zero linhas), antes de qualquer insert, o que encaixa na decisão 2.7 (404 sem persistir nada).
- A idempotência continua decidida pela `UNIQUE (idempotency_key)`, não por um SELECT prévio: o `ON CONFLICT` é quem diz se é duplicata. O lock só serializa o acesso à wallet.
- Custo: um replay também espera o lock da wallet. É aceitável, porque a contenção é por wallet (não há lock global) e o replay é curto.

- Como o lock vem antes da checagem de idempotência, uma key reaproveitada com um payload que aponta para uma wallet inexistente recebe 404, e não 409. Nada é gravado em nenhum dos dois casos.

**Teste:** `test/integration/wallet-lock-order.test.ts`. Um teste de controle, em SQL, reproduz o deadlock de forma determinística com a ordem errada e exige um `40P01`. Os testes de carga passam pela API, ou seja, pelo use case real: 50 apostas distintas e 50 cópias da mesma aposta em paralelo na mesma wallet. Eles falham com qualquer 5xx e com qualquer log de `40P01` ou `55P03`. Com a ordem invertida (um `FOR KEY SHARE` injetado antes do `FOR UPDATE`), o teste das 50 apostas falha. Um teste de sanidade segura o `FOR UPDATE` numa transação externa, confirma por `pg_stat_activity` que duas requisições ficam bloqueadas e que elas completam depois da liberação.

### 5.2 Decidir sob o lock e inserir a transação já no estado final
Com a wallet travada, o use case aplica a regra em memória (domínio) e só então faz o `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`, já com `status`, `failure_code` e `balance_after` definitivos. Se o INSERT não inserir nada, a decisão é descartada (nada foi gravado), a linha existente é carregada e o `payload_hash` decide entre replay e 409. Se inserir, gravam-se o lançamento, o `UPDATE wallets ... WHERE version = ?` e a outbox. Assim BET, WIN e LOSS nunca fazem UPDATE em `wager_transactions`.

### 5.3 `payloadHash`
SHA-256 (hex) do JSON canônico, com chaves ordenadas recursivamente, dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money {amount, currency}` e `referenceExternalTransactionId` (só quando presente). O header `Idempotency-Key`, o `correlationId` e outros metadados de transporte ficam de fora. Todos os valores são strings, e `amount` já passou pela regex estrita do `Money`, então não existe normalização numérica que mude o hash.

### 5.4 Violação de unicidade (23505) mapeada pelo nome da constraint
Só `wt_provider_external_uq` vira `409 EXTERNAL_TRANSACTION_ID_CONFLICT`: o mesmo `externalTransactionId` do provider chegou com outra `Idempotency-Key`. O caminho de idempotência normal nunca chega aqui, porque o `ON CONFLICT (idempotency_key)` já o absorve. Qualquer outra constraint (PK, ledger e as demais) indica bug e vira `500 INTERNAL_ERROR` com log que cita a constraint. Não uso `ON CONFLICT DO NOTHING` sem alvo, que esconderia essas violações e também o índice anti-dupla-reversão.

### 5.5 Pool e `lock_timeout`
O pool tem 20 conexões por padrão (`DB_POOL_MAX`). Cada transação de submissão roda `SET LOCAL lock_timeout` com o valor de `DB_LOCK_TIMEOUT_MS` (default 10000). O valor precisa ser alto o bastante para que uma fila normal de requisições na mesma wallet espere, em vez de falhar: o teste de 50 requisições paralelas na mesma wallet exige zero 503 e zero `40P01`. Estourar o timeout (`55P03`) é contenção anormal e vira `503` com `Retry-After`, que o provedor pode reenviar com segurança pela idempotência. Ele existe para que uma requisição não segure uma conexão do pool indefinidamente atrás de um lock preso.

**Conexão derrubada pelo servidor não pode vazar a vaga do pool (`pool-guard.ts`).** Isto foi encontrado na fatia 6. O Kysely 0.29, usado pelo MikroORM 7, só devolve a conexão ao pool depois que o ROLLBACK dá certo. Se o servidor derruba a sessão no meio da transação (`idle_in_transaction_session_timeout`, restart do Postgres, `pg_terminate_backend`), o ROLLBACK lança erro, o release nunca acontece e a vaga se perde. Com o pool todo perdido, a instância trava, e até o `orm.close()` fica esperando.

A correção usa o hook `onPoolCreated`: quando um cliente emprestado emite `'error'`, chamamos `client.release(error)`, e o pg-pool descarta o cliente. Se o cliente já estava ocioso, o "already released" é ignorado de propósito. O teste `pool-recovery.test.ts` usa `poolMax: 1`: sem a correção, a transação seguinte nunca consegue conexão.

**Timestamps como texto.** O MikroORM registra um parser que devolve `timestamptz` como texto nas consultas cruas. Os repositórios convertem esse texto para `Date` explicitamente (`timestamps.ts`). Antes desta correção, as datas reidratadas eram strings tipadas como `Date`.

### 5.6 OPENING: valores sintéticos e provider reservado
A transação interna `OPENING` preenche as colunas NOT NULL com valores sintéticos e determinísticos: `provider_id = 'internal'`, `external_transaction_id = 'opening:{walletId}'`, `idempotency_key = 'internal:opening:{walletId}'` e `payload_hash` = SHA-256 do JSON canônico de `{kind: 'OPENING', walletId, playerId, money}`. `round_id` e `game_id` ficam NULL, como o CHECK `wt_round_game_required` já permite. Em `PROCESSED`, `balance_after` é o próprio saldo inicial.

O provider `internal` é **reservado**. A API e a fila recusam com 400 um `providerId` igual a `internal` (sem diferenciar maiúsculas) e uma `Idempotency-Key` que comece com `internal:`. O domínio também recusa em `WagerTransaction.create`, e a migration 0003 coloca isso no schema: `CHECK ((provider_id = 'internal') = (kind = 'OPENING'))`. Assim, nenhum provedor colide com as chaves da abertura nem forja uma OPENING. A abertura gera só `WalletBalanceChanged` na outbox: ela não é uma transação de provedor.

### 5.7 `PLAYER_MISMATCH`
Uma transação cujo `playerId` não é o dono da `walletId` é **persistida como REJECTED** com `PLAYER_MISMATCH` (422), e não descartada. Assim fica auditável e idempotente (o reenvio é replay). Ela não altera saldo nem gera ledger. Exigiu a migration 0003, que acrescenta o código ao `CHECK wt_failure_code_valid`; o `down` converte as linhas para `REFERENCE_MISMATCH`, com perda de detalhe, como na 0002. Ordem das checagens sob o lock: player, depois moeda (`CURRENCY_MISMATCH`), depois a regra do tipo.

### 5.8 Saldo observado na moeda da wallet
`balance_after` é sempre o saldo da wallet e, portanto, está na moeda **da wallet**. Isso só faz diferença em `CURRENCY_MISMATCH`, quando a moeda da transação é outra. O domínio aceita isso em `reject`; `markProcessed` continua exigindo a mesma moeda, porque só se processa quando as moedas batem. O replay lê a moeda do saldo por JOIN com `wallets`, não pela coluna `currency` da transação.

### 5.9 Contrato HTTP da submissão
- Transação (primeira vez e replay): `{transactionId, status, failureCode, balance, idempotentReplay}`, com `failureCode` `null` quando não há. PROCESSED → 200, REJECTED → 422 e PENDING_REFERENCE → 202 (com `balance: null`, porque ainda não houve saldo observado). O replay devolve a resposta do estado **atual** da transação com `idempotentReplay: true` e o saldo observado na época (seção 5.10).
- Erros: `{code, message}`, com `code` legível por máquina: `INVALID_PAYLOAD` (400, com `details`), `WALLET_NOT_FOUND` (404), `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT` e `WALLET_ALREADY_EXISTS` (409), `SERVICE_UNAVAILABLE` (503 com `Retry-After`) e `INTERNAL_ERROR` (500).
- `Idempotency-Key`: obrigatório, de 1 a 255 caracteres ASCII visíveis (`0x21` a `0x7E`), sem o prefixo reservado `internal:`.
- Validação estrita, escrita à mão (sem dependência nova): campos desconhecidos são recusados, porque não entram no hash e mudariam o significado da requisição sem mudar a idempotência. `amount` só como string no formato do `Money`, então `25`, `"25.5"` e `"1e3"` dão 400. `kind = OPENING` dá 400. `playerId` e `walletId` precisam ser UUID.
- O `501 REFERENCE_NOT_SUPPORTED_YET` temporário da fatia 4 saiu na 4b.

### 5.10 Reversões (REFUND e ROLLBACK)
Tudo acontece na transação da submissão, com a wallet já travada, antes do INSERT (mesma regra de 5.2: a linha nasce no estado final). Ordem das checagens: player (`PLAYER_MISMATCH`), moeda da wallet (`CURRENCY_MISMATCH`), referência por `(providerId, referenceExternalTransactionId)` → `validateReference` (identidade, tipo, moeda, valor, status; seção 4.4) → `ALREADY_REVERSED` → saldo (`REVERSAL_WOULD_OVERDRAW`) → lançamento e `PROCESSED`. O código compartilhado está em `src/application/wagering/wager-rules.ts`, usado pela submissão e pelo resolve (5.11), para que os dois caminhos decidam igual.

**Ler a referência sem lock próprio.** A referência é lida com um SELECT simples. Isso só é seguro porque `validateReference` confere a **identidade antes do status**. Se a identidade passa, a referência é da wallet que travamos, e toda mudança de status de uma transação dessa wallet acontece sob esse mesmo lock (regra de 5.11), então o status lido não muda até o commit. Uma referência de outra wallet é rejeitada pela identidade, que é imutável, sem que o status dela (que outra transação poderia estar mudando) influencie a decisão. Se o status fosse checado antes, uma referência alheia poderia gerar `wait` ou `REFERENCE_NOT_PROCESSED` a partir de um valor instável. Em READ COMMITTED, o SELECT emitido depois do `FOR UPDATE` enxerga tudo o que foi commitado antes de obtermos o lock.

**`ALREADY_REVERSED` sob o lock, antes do INSERT.** É um `SELECT 1` com o mesmo predicado do índice `wt_single_reversal_uq`. Como todas as reversões de uma referência estão na mesma wallet, o lock serializa as tentativas: a segunda vê a primeira já commitada e é rejeitada de forma auditável. O índice continua como rede final: se for violado, isso é bug e vira 500 (5.4). **Vence a reversão que obtém o lock e é resolvida primeiro**, seja REFUND ou ROLLBACK, seja pela submissão ou pelo resolve de uma pendente.

**Referência ausente ou não terminada.** Ausente, `PENDING` ou `PENDING_REFERENCE`: a reversão é gravada em `PENDING_REFERENCE`, com `attempts = 0` e `next_attempt_at = now + backoff(1)`, responde 202 e grava `WagerTransactionPendingReference` na outbox (só nesse momento, nunca em retry). `REJECTED` ou `FAILED`: `REFERENCE_NOT_PROCESSED` na hora, porque esperar não adianta.

**Rejeição com vínculo.** Uma reversão rejeitada depois de encontrar a referência (`REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `AMOUNT_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `ALREADY_REVERSED`, `REVERSAL_WOULD_OVERDRAW`) guarda `reference_transaction_id`, para auditoria. Isso não afeta o índice anti-dupla-reversão, que só conta `PROCESSED`.

**Interpretações adotadas:**
- **REFUND de uma BET que já teve WIN é permitido.** O enunciado só exige que a referência seja uma BET `PROCESSED` ainda não revertida. O REFUND devolve a aposta e o WIN continua valendo. Para desfazer o prêmio, o provedor envia um ROLLBACK do WIN. Bloquear isso exigiria inferir o vínculo WIN→BET, que é opcional no payload.
- **ROLLBACK de ROLLBACK** dá `INVALID_REFERENCE_KIND` (`REVERSIBLE_KINDS`). ROLLBACK de LOSS também, porque LOSS não tem efeito a desfazer.
- **ROLLBACK de um REFUND** debita o crédito do REFUND, mas a BET continua com um REFUND `PROCESSED` apontando para ela. Um novo REFUND ou ROLLBACK da BET dá `ALREADY_REVERSED` (uma reversão por referência, no total; seção 2.4).
- **OPENING é inalcançável como referência.** Ela usa o provider reservado `internal` (5.6), e a busca é pelo `providerId` do pedido, então um provedor nunca a encontra: a reversão fica `PENDING_REFERENCE` e termina em `REFERENCE_NOT_FOUND` pelo worker. Se fosse carregada, a identidade (provider e rodada diferentes) já daria `REFERENCE_MISMATCH`. Em nenhum caso o saldo de abertura é revertido.
- **Referência de outro provider** nunca é encontrada, pelo mesmo motivo: fica pendente até o limite.
- **WIN e LOSS com `referenceExternalTransactionId`: só informativo.** O campo é guardado e entra no hash, mas nunca é resolvido (`reference_transaction_id` fica NULL) e nunca deixa a transação pendente. Um WIN não deve esperar a BET para creditar, e o enunciado diz só que ele "pode referenciar".
- **O replay reflete o estado atual.** A resposta do replay vem da linha gravada: 202 enquanto a reversão está pendente e, depois de resolvida, o resultado final (200 ou 422), com o saldo observado no momento da resolução. É a mesma resposta que o provedor receberia se tivesse chegado depois da resolução.
- **Latência até o próximo ciclo do worker.** Quando a referência chega, a reversão pendente **não** é resolvida na mesma requisição: ela espera o próximo ciclo do worker (seção 8), limitado por `next_attempt_at`. Resolver em linha deixaria o caminho da submissão mais complexo e duplicaria o worker; o custo é a reversão ficar visível como pendente por até um intervalo de backoff (até 5 min). A melhoria que encurta isso está em 8.7.

### 5.11 `ResolvePendingReference` e a ordem de locks
Use case que reavalia **uma** transação `PENDING_REFERENCE`. O worker da seção 8 o chama para cada pendente vencida. Uma transação SQL:
1. lê a linha **sem lock**, só para descobrir o `walletId` (imutável);
2. `SELECT ... FOR UPDATE` na wallet;
3. **relê a linha sob o lock** e termina como **no-op** se ela já não está `PENDING_REFERENCE` (`not_pending`: outra instância resolveu antes) ou se o `next_attempt_at` ainda está no futuro (`not_due`: outra instância já contou esta tentativa; 8.1);
4. aplica as mesmas regras da submissão (5.10) e faz `UPDATE ... WHERE id = ? AND status = 'PENDING_REFERENCE'`, mais ledger, saldo e outbox, na mesma transação. Os eventos são os mesmos do caminho normal (`WagerTransactionProcessed` ou `Rejected`, e `WalletBalanceChanged` se o saldo mudou). Se a referência continua inutilizável, ou conta a tentativa e reagenda (8.2), sem evento, ou, com o prazo esgotado, rejeita (8.3).

O UPDATE confere as linhas afetadas, e algo diferente de 1 lança erro e desfaz a transação. Esse erro é só para o caso impossível: a releitura sob o lock já garantiu que a linha está pendente. Uma corrida entre dois resolves termina com um aplicando e o outro em no-op, sem erro (teste `reversal-concurrency.test.ts`).

**Ordem de locks (regra do sistema): wallet primeiro, sempre.** Todo caminho que muda uma `wager_transaction` ou o saldo trava a linha da wallet **antes** de qualquer outro lock de linha. Isso vale para submissão, resolve e worker. O worker da fatia 8 **não pode** travar a linha da transação (por exemplo, com `FOR UPDATE SKIP LOCKED` em `wager_transactions`) e depois a wallet: a submissão faz wallet → transação, e a ordem invertida reabre o ciclo de deadlock de 5.1. O worker deve **selecionar candidatos sem segurar o lock da transação**, ou usar `SKIP LOCKED` só numa transação curta de "reserva" que termina antes de travar a wallet, e então chamar este use case, que trava na ordem certa. Pela mesma razão, todo UPDATE em `wager_transactions` acontece sob o lock da wallet, o que é a premissa da leitura sem lock em 5.10.

## 6. Publisher da outbox

### 6.1 Destino e atributos da mensagem
Os eventos vão para a fila FIFO `wager-events.fifo`, criada no boot do LocalStack (`docker/localstack/init-sqs.sh`) com a DLQ `wager-events-dlq.fifo` (`maxReceiveCount` 5). A DLQ atende aos **consumidores** dos eventos; o publisher nunca manda nada para ela. Cada evento vira uma entrada do `SendMessageBatch`:
- `MessageDeduplicationId` = `eventId` (o `id` da outbox): um reenvio do mesmo evento é descartado pelo FIFO;
- `MessageGroupId` = `aggregateId`, que é a `walletId` (4.5). A ordem por wallet é **só otimização**;
- corpo = envelope JSON do evento (`IntegrationEvent.toJSON()`, o mesmo gravado em `payload`), e `eventType` vai como atributo.

O cliente do SDK tem `maxAttempts: 1`: o retry é o backoff da outbox, gravado no banco. Com retry também no SDK, a duração de uma chamada ficaria imprevisível e os dois retries se somariam.

**Teste de fumaça (`outbox-sqs-dedup.test.ts`):** dois envios com o mesmo `MessageDeduplicationId` resultam em uma mensagem só no LocalStack 3.8, e o segundo envio volta como sucesso. Por isso os testes de crash e de concorrência exigem **cada `eventId` exatamente uma vez na fila**, e não só "nenhum perdido".

### 6.2 Claim, envio e marcação na mesma transação
Cada tick (`PublishOutboxBatch`) roda numa única transação:
1. `SELECT ... WHERE published_at IS NULL AND next_attempt_at <= $now ORDER BY next_attempt_at, id LIMIT $n FOR UPDATE SKIP LOCKED`;
2. `SendMessageBatch` com timeout;
3. `published_at` nas entradas aceitas e `scheduleRetry` (`attempts + 1`, backoff) nas demais;
4. commit.

O `SKIP LOCKED` faz cada publisher pegar só linhas que nenhum outro travou, sem esperar e sem lock global. O lock dura até o commit, então uma linha nunca está em dois lotes ao mesmo tempo. Os `UPDATE` têm guarda `published_at IS NULL` e conferem que afetaram 1 linha.

**Trade-off.** A conexão e o lock das linhas ficam presos durante a chamada ao SQS. O lock é só nas linhas da **outbox**: a submissão apenas faz INSERT nessa tabela e nunca trava uma linha pendente, então não é bloqueada. Para limitar o custo:
- o lote tem no máximo 10 mensagens (`OUTBOX_BATCH_SIZE`, que é o limite do `SendMessageBatch`);
- a chamada tem teto (`OUTBOX_SEND_TIMEOUT_MS`, default 5 s), aplicado pelo use case com `Promise.race` mais `AbortSignal`, de modo que não depende do adaptador respeitar o sinal;
- cada instância roda um publisher, ou seja, usa uma conexão do pool.

A alternativa de "reservar" em uma transação e marcar em outra (lease com `locked_until`) libera a conexão durante o envio, mas pede uma coluna a mais e uma recuperação de leases vencidas. Ficou de fora por complexidade.

**`idle_in_transaction_session_timeout`.** É a rede de proteção para o caso de o processo travar com a transação aberta: o Postgres derruba a sessão e solta as linhas. Durante a chamada ao SQS a sessão está, por definição, **ociosa dentro da transação**, então esse timeout tem de ser bem maior que o de envio. Default: `max(3 × OUTBOX_SEND_TIMEOUT_MS, 15 s)` (`OUTBOX_IDLE_TX_TIMEOUT_MS`). A configuração recusa um valor menor. Ele é aplicado com `SET LOCAL`, então vale só para a transação do lote. O teste `outbox-publisher.test.ts` prova que um envio lento, ainda dentro do timeout, não derruba a sessão.

**Relógio da aplicação.** O `$now` do claim vem do `Clock`, o mesmo relógio que gravou `occurred_at` e `next_attempt_at`. Os três use cases gravam `next_attempt_at = occurredAt = clock.now()` explicitamente no INSERT, e o `DEFAULT now()` da coluna nunca é usado (teste em `outbox-publisher.test.ts`). Assim o backoff é determinístico nos testes, e não há mistura entre o relógio do banco e o da aplicação.

### 6.3 Entrega at-least-once e resultados ambíguos
Nada é marcado antes do commit. Se o processo morre depois do envio e antes do commit, ou se o próprio commit falha, a transação é desfeita, a linha continua pendente e outro publisher a reenvia com o mesmo `eventId`.

O FIFO deduplica dentro da janela de **5 minutos**. Depois dela, um reenvio pode gerar duplicata, e por isso **o consumidor tem de ser idempotente**: inbox por `eventId` e `walletVersion` para descartar estado antigo.

**Timeout é resultado ambíguo**: o broker pode ter aceitado as mensagens e a resposta não chegou. O lote inteiro recebe retry, e a deduplicação resolve o caso.

Uma exceção na chamada (rede, fila inexistente, credencial) também leva o lote inteiro para retry, com `outbox_publish_call_failures_total{reason=timeout|call_error}` e log `warn`.

**Falha por entrada (falha parcial do `SendMessageBatch`).** O campo `SenderFault` separa dois casos:
- **erro do remetente**: o broker recusou o que enviamos, o que indica bug. Recebe retry mesmo assim, para nunca descartar o evento, mas com log `error` e um contador próprio (`outbox_sender_faults_total{code}`) para gerar alerta;
- **erro do serviço**: retry com log `warn`.

Uma entrada que não aparece na resposta também recebe retry, e nunca é tratada como publicada.

### 6.4 Retry sem limite e reordenação
O retry não tem limite de tentativas. O backoff vem do domínio (4.6), `1 s · 2^(attempts-1)` com teto de 5 min, e o evento nunca é descartado. Um "DLQ da outbox" tiraria o evento do fluxo normal, e para um evento financeiro isso é perda. Um `attempts` alto aparece no log e nas métricas.

**Reordenação.** A ordem por wallet do FIFO é só otimização. Ela quebra em três situações:
- **falha parcial dentro de um lote**: o evento da versão 2 de uma wallet é aceito e o da versão 1 falha. O da versão 1 sai depois, num retry, já atrás do da versão 2;
- **retry com backoff**: um evento atrasado sai depois de eventos mais novos da mesma wallet;
- **publishers concorrentes**: dois lotes diferentes podem levar eventos da mesma wallet.

Não é viável impedir isso sem serializar a publicação por wallet, o que seria um lock global por agregado. Por isso **o consumidor ordena pelo `walletVersion` do `WalletBalanceChanged`**, e não pela ordem de chegada. O claim usa `ORDER BY next_attempt_at, id`, que segue o índice parcial e, na ausência de retries, a ordem de criação (UUIDv7).

**Contrato para quem consome `wager-events.fifo`** (este serviço não consome essa fila; o consumidor da seção 7 é o de `wager-transactions.fifo`):
- deduplicar por `eventId` numa inbox persistente: depois da janela de 5 min do FIFO, um reenvio da outbox chega duplicado (6.3);
- ordenar o estado da wallet pelo `walletVersion` do `WalletBalanceChanged` e descartar versões menores ou iguais à já aplicada, nunca pela ordem de chegada.

### 6.5 Laço e shutdown
Cada instância roda um `OutboxPublisherWorker` (desligável com `OUTBOX_PUBLISHER_ENABLED=false`). Se o lote veio cheio, o próximo tick roda na hora; se veio incompleto, espera `OUTBOX_POLL_INTERVAL_MS` (default 500 ms), num sono interrompível. Um tick que falha (banco fora do ar) é desfeito, gera log e incrementa `outbox_tick_errors_total`, e o laço continua.

**Shutdown.** O `stop()` roda no hook `beforeApplicationShutdown` do Nest, disparado por `app.close()` ou pelo SIGTERM (`enableShutdownHooks`). Ele para de buscar lotes, acorda o laço se estiver dormindo e **espera o lote em andamento chegar ao commit**. Só depois disso o MikroORM fecha o pool, no hook `onApplicationShutdown`.

**Limitação do ambiente:** no Windows não há SIGTERM real entre processos; o `kill` do Bun termina o processo à força. O teste de shutdown chama `app.close()`, que percorre os mesmos hooks. O caso de morte abrupta é coberto pelo teste de crash (6.3).

### 6.6 Outbox lag
`outbox_lag_seconds` = `now − min(occurred_at)` dos eventos pendentes, incluindo os que esperam retry (zero quando não há nenhum). É medido ao fim de cada tick. Vai para a porta `Metrics`, por enquanto num registro em memória por instância; a exposição em `/metrics` fica para a fatia 9.

Contadores: `outbox_published_total`, `outbox_retries_total{fault}`, `outbox_sender_faults_total{code}`, `outbox_publish_call_failures_total{reason}` e `outbox_tick_errors_total`.

## 7. Consumidor SQS de `wager-transactions.fifo`

### 7.1 Mensagem e `payloadHash`
O envelope é o do enunciado: `{messageId, type, occurredAt, data}`, validado de forma estrita (campo desconhecido no envelope é recusado, como no corpo HTTP). `type` precisa ser `WagerTransactionRequested`. `data` passa pelo **mesmo** validador do HTTP (`parseWagerTransactionPayload`), então `OPENING`, o provider `internal`, campos desconhecidos e `amount` fora do formato são recusados do mesmo jeito.

`data.idempotencyKey` é o equivalente do header `Idempotency-Key`: sai de `data` antes da validação, passa pelas mesmas regras do header e, se ausente, assume `{providerId}:{externalTransactionId}`. O `payloadHash` da transação é o `hashWagerPayload` do HTTP, sobre a mesma lista explícita de campos de negócio: `messageId`, `type`, `occurredAt` e a key ficam de fora. Por isso a mesma transação enviada pelo HTTP e depois pela fila é **replay**, e não conflito (teste unitário compara os dois hashes; teste de integração faz o caminho completo).

`correlationId` é o `messageId` do envelope e `causationId` é o `MessageId` do SQS.

### 7.2 Inbox na transação da submissão
O comando do use case ganha um campo opcional `inbox: {consumerName, messageId}`. Com ele, o **primeiro** passo da transação SQL (antes do lock da wallet, ordem de 5.1) é:

`INSERT INTO inbox ... ON CONFLICT ON CONSTRAINT inbox_pk DO NOTHING RETURNING`

- **Inseriu:** segue o fluxo normal. `processed_at` é gravado no próprio INSERT, porque recebimento e efeito financeiro entram no mesmo commit; não existe linha "recebida e não processada".
- **Não inseriu, mesmo hash:** entrega repetida. Como a inbox só é commitada junto com a transação (nova ou replay), a transação existe: é carregada pela key e devolvida com `duplicateDelivery: true`, **sem travar a wallet** e sem gravar nada.
- **Não inseriu, hash diferente:** `INBOX_MESSAGE_CONFLICT`, erro permanente (DLQ). Um `messageId` reaproveitado com outro conteúdo não é redelivery: ou é bug do produtor, ou colisão de ids. Processá-lo seria aceitar uma mensagem que a inbox diz já ter visto; descartá-lo com ack apagaria o rastro. A DLQ preserva a mensagem para análise.

**Hash da inbox ≠ `payloadHash`.** A inbox guarda o SHA-256 do JSON canônico de `{idempotencyKey, payload: campos de negócio}`. A key entra porque duas mensagens com o mesmo `messageId` e keys diferentes também são conteúdo diferente, ainda que o negócio seja idêntico. O `payloadHash` da transação continua sem a key (5.3), para casar com o HTTP.

**Atomicidade.** Qualquer erro depois do INSERT da inbox (`WALLET_NOT_FOUND`, conflito de key, falha transitória) desfaz a transação inteira, inclusive a inbox: uma nova entrega é avaliada do zero. É o que permite a falha transitória ser reprocessada.

**Entregas concorrentes da mesma mensagem** (por exemplo, visibilidade expirada enquanto a primeira ainda processa): a segunda espera no índice da PK até a primeira terminar. Se a primeira commitou, a segunda vê o conflito e é duplicata; se desfez, a segunda insere. O `ON CONFLICT` absorve o caso, sem 23505 (teste de estresse em 7.8).

**Dois níveis de duplicata**, ambos na métrica `sqs_consumer_duplicates_total{level}`:
- `level=inbox`: o mesmo `messageId` de novo (redelivery do SQS, reenvio do produtor);
- `level=idempotency`: `messageId` novo para a mesma transação de negócio (mesma key e mesmo `payloadHash`), ou a mesma transação já submetida pelo HTTP. A inbox ganha a linha nova e o use case devolve o replay.

### 7.3 Classificação das falhas
| Resultado | Ação |
|---|---|
| PROCESSED, REJECTED, PENDING_REFERENCE, replay, duplicata | ack (`DeleteMessage`) **depois** do commit |
| JSON inválido, envelope inválido, tipo desconhecido, `data` inválido (inclui OPENING e `internal`), `WALLET_NOT_FOUND`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `INBOX_MESSAGE_CONFLICT` | **permanente**: DLQ explícita com motivo, depois ack |
| `TransientInfrastructureError` (conexão, `40P01`, `40001`, `55P03`, ...) | **transitório**: sem ack, `ChangeMessageVisibility` com backoff |
| Erro inesperado (bug) | transitório com backoff curto e log `error` com stack (sem payload) |

REJECTED é erro de **negócio**: é um resultado persistido e idempotente, e recebe ack como qualquer outro. O erro permanente vai **direto** para a DLQ em vez de esperar o redrive: no FIFO, uma mensagem não apagada bloqueia o grupo (a wallet) até sair, e uma mensagem que nunca vai dar certo bloquearia as seguintes da mesma wallet por `maxReceiveCount × visibilidade`. O erro inesperado é tratado como transitório porque não sabemos se ele se repete: descartar uma mensagem válida por causa de um bug passageiro seria pior do que tentar de novo algumas vezes. O backoff dele é curto (1 s a 5 s). O log `error` leva o nome do erro, o SQLSTATE (se houver) e **só os frames** do stack (`at ...`). A primeira linha do `stack` repete a mensagem do erro, que é texto livre: um bug ou o próprio Postgres (`invalid input syntax for type numeric: "..."`) podem citar valores. Nenhum log do consumidor traz o corpo da mensagem nem a mensagem de um erro inesperado; os campos são ids (`messageId`, `sqsMessageId`, `transactionId`, `walletId`, `providerId`, `correlationId`), status, motivo e contagens. O `afterEach` de `sqs-consumer.test.ts` falha se algum log contiver um valor monetário, `"money"` ou `"amount"`.

### 7.4 Tentativas, backoff, visibilidade e concorrência
**Retry pela visibilidade.** Uma falha transitória não recebe ack. O consumidor chama `ChangeMessageVisibility` com `backoff(ApproximateReceiveCount)` (default de 1 s a 60 s, `SQS_CONSUMER_BACKOFF_BASE_MS`/`_MAX_MS`), e a mensagem reaparece depois desse prazo. O estado do retry fica no próprio SQS, sem tabela. A transação desfeita levou a inbox junto (7.2), então a nova entrega é avaliada do zero.

**Limite de tentativas.** Quando `ApproximateReceiveCount >= SQS_CONSUMER_MAX_ATTEMPTS` (default 5) e a falha ainda é transitória, o **consumidor** manda a mensagem para a DLQ com `failureReason=MAX_ATTEMPTS_EXCEEDED` e `failureDetail` = o motivo da última falha (`55P03`, `SERVICE_UNAVAILABLE`, `UNEXPECTED_ERROR`...).

**Redrive como rede de segurança, em pelo menos 3× o limite.** O `ApproximateReceiveCount` conta **toda** entrega, inclusive as devoluções com visibilidade 0 (7.5 e 7.7). Uma mensagem que está atrás de outra em retry no mesmo grupo é recebida e devolvida a cada tentativa da primeira, sem ser processada. Se o `maxReceiveCount` da `RedrivePolicy` fosse igual ao limite do consumidor, o próprio SQS poderia mandar essa seguidora para a DLQ sem que ela tivesse sido tentada nenhuma vez. Por isso:
- a fila do LocalStack tem `maxReceiveCount` 15 (= 3 × 5; `init-sqs.sh`);
- o consumidor confere a `RedrivePolicy` no boot e **recusa subir** se `maxReceiveCount < 3 × SQS_CONSUMER_MAX_ATTEMPTS`; sem `RedrivePolicy`, só avisa;
- o redrive do SQS só age se o processo morrer em loop numa mensagem (crash antes de qualquer decisão). Nesse caso a mensagem chega à DLQ sem atributo de motivo.

**Limitação conhecida.** Como o contador inclui devoluções, uma seguidora pode chegar à vez dela já com `receiveCount` alto, e uma única falha transitória nela a levaria direto à DLQ do consumidor. O teste "falha persistente na frente e BET válida atrás" garante o caso principal: a líder vai para a DLQ e a seguidora é processada no mesmo lote, sem falhar. Contar tentativas reais exigiria guardar estado por mensagem fora do SQS, o que não compensa aqui.

**Visibilidade ≥ `lock_timeout` + margem.** `SQS_CONSUMER_VISIBILITY_TIMEOUT_S` (default 30) é a visibilidade pedida no `ReceiveMessage`. A configuração recusa um valor menor que `DB_LOCK_TIMEOUT_MS` + 5 s (`CONSUMER_PROCESSING_MARGIN_MS`): o pior caso de uma mensagem é esperar o lock da wallet até o timeout, e a mensagem não pode reaparecer para outra instância enquanto a primeira ainda trabalha nela. Mesmo assim, se reaparecer, a inbox resolve (7.2). Pelo mesmo motivo, antes de **começar** cada mensagem o consumidor confere o prazo: se faltar menos que esse orçamento para a visibilidade acabar (mensagens no fim de um grupo longo), devolve a mensagem (`released_total{reason=lease_expiring}`) em vez de começar.

**Concorrência abaixo do pool.** `SQS_CONSUMER_CONCURRENCY` (default 10) é o número de mensagens processadas em paralelo por instância. Cada uma segura uma conexão durante a transação. Ela entra no orçamento do pool junto com o publisher e o worker de pendentes, com 5 conexões reservadas para o HTTP (8.5).

### 7.5 Lote, grupos e ordem
O long polling (`WaitTimeSeconds` 20, até 10 mensagens) devolve um lote que pode ter vários `MessageGroupId`. O lote é dividido por grupo: **grupos em paralelo** (até a concorrência) e **mensagens do mesmo grupo em sequência**. Se uma mensagem fica para retry, as seguintes do mesmo grupo são devolvidas com visibilidade 0 (`released_total{reason=group_on_hold}`). O FIFO não entrega mensagens de um grupo enquanto outra do mesmo grupo está em voo, então elas voltam **depois** da que falhou.

Isso é só otimização: `MessageGroupId = walletId` não é premissa de consistência. O teste de estresse (7.8) usa um `MessageGroupId` **diferente por mensagem** na mesma wallet, e três processos consomem em paralelo. A consistência vem do `FOR UPDATE` na wallet, da `UNIQUE` da idempotência e da PK da inbox.

### 7.6 DLQ
O consumidor envia para `wager-transactions-dlq.fifo` com `SendMessage` e só então faz o ack na fila de origem:
- corpo idêntico ao original e **o mesmo `MessageGroupId`**;
- `MessageDeduplicationId` = `MessageId` do SQS da original. Se o processo morrer entre a cópia e o ack, a redelivery copia de novo, e o FIFO da DLQ descarta a segunda dentro da janela de 5 min. Depois dela, a DLQ pode ter uma cópia duplicada, o que é inofensivo (ver abaixo);
- atributos `failureReason`, `failureDetail` (até 256 caracteres, sem payload), `sourceMessageId` e `receiveCount`;
- se o `SendMessage` falhar, **não há ack**: a mensagem volta pela visibilidade e nunca se perde.

**Reenviar da DLQ para a fila é seguro.** O corpo é o mesmo, então o `messageId` do envelope e a key também são. Se a mensagem chegou a ser commitada (o que não acontece com erro permanente, mas pode acontecer numa cópia duplicada), a inbox a reconhece como duplicata. Se não, ela é processada normalmente, por exemplo depois que a wallet inexistente foi criada. Uma mensagem com `INBOX_MESSAGE_CONFLICT` continua em conflito se for reenviada, de propósito.

### 7.7 Shutdown
O `stop()` roda no `beforeApplicationShutdown` (`app.close()` ou SIGTERM), antes de o pool fechar:
1. marca `stopping` e **aborta o long poll** em andamento (`AbortSignal` no `ReceiveMessage`);
2. devolve **na hora** a visibilidade (0) de todas as mensagens recebidas que ainda não começaram, inclusive as que estão na fila de um grupo atrás de uma mensagem em andamento;
3. espera as mensagens em andamento chegarem ao commit e ao ack (ou à decisão de retry ou DLQ).

**Efeito do abort do long poll.** O abort cancela a requisição HTTP do lado do cliente. Se o SQS já tinha separado mensagens para essa resposta no instante do abort, elas ficam em voo com a visibilidade pedida (30 s) sem que o consumidor saiba delas, e voltam para a fila quando ela acaba. Nada se perde nem é processado: o custo é um atraso de até `SQS_CONSUMER_VISIBILITY_TIMEOUT_S` para essas mensagens. A alternativa, esperar o long poll terminar sozinho, atrasaria todo shutdown em até 20 s. Se a resposta chega junto com o abort, o lote inteiro é devolvido com visibilidade 0.

A mesma limitação do Windows de 6.5 vale aqui: o teste de shutdown chama `stop()` diretamente, e a morte abrupta é coberta pelo teste de crash.

### 7.8 Métricas e testes
Métricas (porta `Metrics`, em memória até a fatia 9): `sqs_consumer_messages_total{outcome}` (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, `duplicate`, `replay`, `dead_lettered`), `sqs_consumer_duplicates_total{level=inbox|idempotency}`, `sqs_consumer_retries_total{reason}` (com o SQLSTATE quando houver, por exemplo `55P03` para conflito de lock), `sqs_consumer_dlq_total{reason}`, `sqs_consumer_released_total{reason}`, `sqs_consumer_processing_seconds` (contagem, soma e máximo) e contadores de falha de receive, ack e envio à DLQ.

Testes (Postgres e LocalStack reais, com fila e DLQ temporárias criadas por teste ou por arquivo; todos terminam com `saldo == ledger`):
- `inbox-submission.test.ts` (use case, sem fila): duplicata pela PK, conflito de `messageId` (payload e key), replay com `messageId` novo, REJECTED com inbox, `WALLET_NOT_FOUND` e 409 desfazendo a inbox;
- `sqs-consumer.test.ts`: checagem do redrive; a mesma mensagem entregue 10 vezes (com `MessageDeduplicationId` diferentes, senão o próprio FIFO descartaria as cópias); `messageId` novo para a mesma transação (`level=idempotency`); HTTP e depois SQS é replay; mensagens venenosas (JSON inválido, tipo desconhecido, OPENING, wallet inexistente, `messageId` repetido com outro payload, mesma key com outro payload, mesmo `externalTransactionId` com outra key) vão para a DLQ com motivo e o mesmo grupo, sem segurar a BET seguinte da wallet; `55P03` por lock externo é reprocessado e aplicado uma vez; falha transitória e erro inesperado persistentes vão para a DLQ no limite, e a BET atrás deles no mesmo grupo é processada; REFUND antes da BET; shutdown que devolve as não iniciadas na hora e conclui a em andamento;
- `sqs-consumer-crash.test.ts`: processo filho morto depois do commit e antes do ack; a redelivery é duplicata;
- `sqs-consumer-concurrency.test.ts`: três processos consumindo a mesma fila e a mesma wallet, com `MessageGroupId` diferente por mensagem, 40 apostas mais 20 redeliveries e 5 replays em ordem embaralhada (exatamente 20 PROCESSED, 20 REJECTED, saldo 0.00, versão 21, nada na DLQ); e 20 rodadas de duas execuções simultâneas do use case com o mesmo `messageId` (um efeito, uma duplicata, nenhuma exceção).

## 8. Worker de PENDING_REFERENCE

### 8.1 Listar sem lock, decidir sob o lock da wallet
Cada instância roda um `PendingReferenceWorker` (desligável com `PENDING_REFERENCE_WORKER_ENABLED=false`). Cada ciclo (`runOnce`):
1. lista as vencidas numa transação curta: `SELECT id ... WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= $now ORDER BY next_attempt_at, id LIMIT $batch`, **sem** `FOR UPDATE` e **sem** `SKIP LOCKED` (usa o índice parcial `wt_pending_reference_due_idx`);
2. chama o `ResolvePendingReference` (5.11) para cada id, com no máximo `PENDING_REFERENCE_CONCURRENCY` em paralelo.

**Por que não `SKIP LOCKED` como no publisher.** Travar a linha da transação antes da wallet inverte a ordem de locks (5.11): a submissão faz wallet → transação, e o worker faria transação → wallet, reabrindo o deadlock de 5.1. Reservar as linhas numa transação separada exigiria uma coluna de lease e a recuperação de leases vencidas. Em vez disso, a listagem pode repetir linhas entre instâncias, e quem decide é o resolve, sob o lock da wallet.

**Um único incremento por vencimento.** Duas instâncias listam a mesma linha vencida e chamam o resolve. As duas fazem fila no `FOR UPDATE` da wallet. A primeira decide: resolve, expira ou conta a tentativa e move `next_attempt_at` para o futuro. A segunda, ao reler a linha sob o lock, vê `status` diferente (`not_pending`) ou `next_attempt_at > now` (`not_due`) e termina sem escrever nada. O `now` é lido **depois** de obter o lock, então quem esperou na fila compara com o relógio atual. O custo de uma listagem repetida é uma espera de lock e uma releitura, nunca uma escrita. Testes: dois resolves simultâneos na mesma pendente (`pending-reference-resolve.test.ts`) e dois workers em apps separados, cada um com seu pool, por 10 rodadas (`pending-reference-worker.test.ts`); em ambos `attempts` sobe exatamente 1.

### 8.2 Cronograma de `next_attempt_at`
`attempts` conta as tentativas de resolução que falharam e foram reagendadas. A submissão agenda `createdAt + backoff(1)`; depois da k-ésima tentativa, `now + backoff(k + 1)`. Assim nenhum degrau é pulado: 1 s, 2 s, 4 s, ... até o teto de 5 min (`PENDING_REFERENCE_BACKOFF_BASE_MS` e `_MAX_MS`). A mesma `PendingReferencePolicy` é injetada na submissão e no resolve, e as datas vêm do `Clock` da aplicação (mesma regra de 6.2). O agendamento **nunca passa de `createdAt + TTL`**: sem esse teto, a expiração poderia atrasar um degrau inteiro. Sem jitter, como em 4.6. O cronograma está em `src/domain/pending-reference-policy.ts` e tem teste de unidade.

### 8.3 Prazo: TTL e tentativas
A espera termina no que vier primeiro:
- **TTL a partir de `created_at`**, default 1 h (`PENDING_REFERENCE_TTL_MS`). Uma reversão chega antes da referência quando há reordenação: grupos diferentes ou retries na fila de entrada (o consumidor tenta 5 vezes com backoff de até 60 s, 7.4), retry de HTTP do provedor, ou instâncias em paralelo. Tudo isso se resolve em minutos. 1 h cobre esses atrasos com folga e ainda limita quanto tempo o provedor espera por uma resposta definitiva. Uma referência que demora mais que isso indica falha operacional (fila parada, mensagem na DLQ), e a reversão rejeitada fica auditável.
- **Limite de tentativas**, default 30 (`PENDING_REFERENCE_MAX_ATTEMPTS`), a rede de segurança. Com o backoff padrão, 1 h dá cerca de 20 tentativas (9 degraus somam ~8,5 min, depois um a cada 5 min), então quem decide é o TTL. As tentativas só pesam se o backoff for configurado pequeno, e nesse caso encerram a espera antes do TTL. Quem reduzir o backoff deve aumentar o limite junto.

**Resolver vem antes de expirar.** Na última tentativa, o resolve aplica as regras normalmente; só se a referência continuar inutilizável é que a transação expira. Uma referência que chegou no fim do prazo ainda é aplicada (teste em `pending-reference-resolve.test.ts`).

**Código da expiração.**
- Referência ausente: `REFERENCE_NOT_FOUND`.
- Referência encontrada mas ainda não aplicada (`PENDING` ou `PENDING_REFERENCE`): `REFERENCE_NOT_PROCESSED`, com `reference_transaction_id` apontando para ela. O código significa "referência conhecida mas não aplicada" (seção 3), o mesmo de quando a referência termina `REJECTED`.

Isso torna o resultado **independente da ordem de avaliação**. Exemplo: um ROLLBACK de um REFUND, e o REFUND espera uma BET que nunca chega. Se o worker avalia o REFUND primeiro, ele expira com `REFERENCE_NOT_FOUND`, e o ROLLBACK depois vê um REFUND `REJECTED` e recebe `REFERENCE_NOT_PROCESSED` pela regra normal. Se avalia o ROLLBACK primeiro, ele expira vendo o REFUND ainda pendente e recebe o mesmo `REFERENCE_NOT_PROCESSED`. Nas duas ordens, o mesmo estado final e nenhum efeito financeiro (teste com as duas ordens). A identidade da referência já foi conferida antes (4.4), então o vínculo é sempre com uma transação da mesma wallet.

**Efeitos.** A expiração é uma rejeição como qualquer outra: `balance_after` = saldo da wallet lido sob o lock, nenhum lançamento, `WagerTransactionRejected` na outbox na mesma transação, e o replay devolve 422 com esse resultado. Ela também encerra o ROLLBACK da OPENING e as referências de outro provider (5.10), que nunca são encontradas.

**Limitação.** Depois de uma rejeição por prazo, a reversão está encerrada. Se a referência aparecer depois (por exemplo, reenviada da DLQ), o provedor precisa mandar a reversão com **novo `externalTransactionId` e nova `Idempotency-Key`**. A mesma key é replay (devolve o 422), e o mesmo `externalTransactionId` com outra key é `409 EXTERNAL_TRANSACTION_ID_CONFLICT` pela `UNIQUE (provider_id, external_transaction_id)` (5.4).

### 8.4 Laço, falhas e linha venenosa
O ciclo seguinte roda **na hora só se o lote veio cheio e nenhum item falhou**; caso contrário, espera `PENDING_REFERENCE_POLL_INTERVAL_MS` (default 1 s), num sono interrompível.

**Falha num item.** O resolve é desfeito por inteiro, sem contar a tentativa, e a linha continua vencida para o próximo ciclo. `lock_timeout` (`55P03`) e outras falhas transitórias geram log `warn`; erro inesperado gera log `error`. Os campos são `transactionId`, nome do erro, SQLSTATE e, no inesperado, só os frames do stack (mesmo critério de 7.3). Contador: `pending_reference_errors_total{reason}`, com o SQLSTATE quando houver. Falha na listagem: `pending_reference_cycle_errors_total`, e o laço espera e continua.

**Linha venenosa.** Uma linha cujo resolve falha sempre (bug, dado corrompido) nunca tem `attempts` incrementado e nunca expira, porque a checagem de prazo roda dentro da transação que falha. Ela fica vencida para sempre e, pelo `ORDER BY next_attempt_at`, volta no início de toda listagem. Consequências:
- um log `error` e um incremento de métrica por ciclo, que servem de alerta;
- ela ocupa uma vaga do lote;
- a regra acima (só repetir na hora se nada falhou) impede que ela vire um laço quente.

Se houver `PENDING_REFERENCE_BATCH_SIZE` linhas venenosas, elas ocupam o lote inteiro e as demais pendentes deixam de ser atendidas até a correção. Para evitar isso, seria preciso registrar a falha numa transação separada (contador de erros e `next_attempt_at` empurrado) ou levar a linha a `FAILED` com `INTERNAL_ERROR` depois de N erros. Ficou de fora: essa escrita aconteceria fora do lock da wallet (ou exigiria travá-la de novo numa segunda transação), contrariando a regra de 5.11 de que todo UPDATE em `wager_transactions` acontece sob o lock da wallet.

### 8.5 Orçamento do pool
Cada resolve em andamento segura uma conexão, assim como cada mensagem do consumidor e o lote do publisher. A configuração exige `SQS_CONSUMER_CONCURRENCY + 1 (publisher) + PENDING_REFERENCE_CONCURRENCY <= DB_POOL_MAX - 5`, contando só os workers ligados. Com os defaults: 10 + 1 + 4 = 15 = 20 − 5. As 5 conexões (`HTTP_RESERVED_CONNECTIONS`) ficam para o HTTP e o health check, mesmo com todos os workers saturados (por exemplo, todos esperando locks). É um piso, não um dimensionamento: com carga HTTP alta, o certo é aumentar `DB_POOL_MAX`. O `lock_timeout` de 5.5 vale também para o resolve.

### 8.6 Shutdown, métricas e testes
**Shutdown.** O `stop()` roda no `beforeApplicationShutdown` (`app.close()` ou SIGTERM), antes de o pool fechar. Ele para de listar, impede que as filas de trabalho comecem linhas novas e espera os resolves em andamento chegarem ao commit. As linhas já listadas e não iniciadas continuam vencidas no banco para a próxima instância.

**Métricas** (porta `Metrics`): `pending_reference_resolved_total{status}`, `pending_reference_expired_total{failureCode}`, `pending_reference_retries_total`, `pending_reference_noop_total{reason}`, `pending_reference_errors_total{reason}`, `pending_reference_cycle_errors_total` e `pending_reference_resolve_seconds`. Ao fim de cada ciclo: os gauges `pending_reference_pending` (quantas estão pendentes) e `pending_reference_oldest_age_seconds` (`now − min(created_at)`, zero quando não há nenhuma).

**Testes** (Postgres e LocalStack reais, relógio manual; todos terminam com `saldo == ledger` e com um `afterEach` que falha se algum log trouxer valor monetário):
- unidade: cronograma (`backoff(1)` na submissão, sem pular degrau, nunca além do prazo, expiração exatamente no prazo), expiração por tentativas com o TTL longe, códigos da expiração, orçamento do pool;
- `pending-reference-resolve.test.ts`: `not_due` antes do vencimento; dois resolves simultâneos com um único incremento; TTL esgotado com o saldo observado sob o lock, o evento na outbox e o replay 422; referência que chega no fim do prazo é aplicada; `maxAttempts = 3` expira na terceira tentativa, 15 min depois da criação; cadeia sem a BET nas duas ordens de avaliação;
- `pending-reference-worker.test.ts`: reversão resolvida quando a referência chega, com os eventos lidos de uma fila FIFO no LocalStack; dois workers em apps separados; TTL esgotado com o `Rejected` na outbox e depois na fila; cadeia ROLLBACK de REFUND que espera a BET convergindo em até dois ciclos; reinício (uma instância conta a tentativa e para, outra resolve); shutdown com o resolve bloqueado num lock externo (o `app.close()` só termina depois do commit, e a segunda linha listada não é iniciada).

**Nota de teste.** O logger do Nest é estático: os `new Logger(...)` escrevem no logger do **último** app criado. Os testes que sobem vários apps passam um `CapturingLogger` compartilhado, para que a checagem de valores monetários veja todas as entradas.

### 8.7 Melhoria futura: acordar pendentes quando a referência chega
Hoje a reversão espera o próximo vencimento depois que a referência chega, o que leva até um degrau de backoff (5.10). A melhoria: quando a submissão processa uma transação, na mesma transação e sob o mesmo lock da wallet, fazer `UPDATE wager_transactions SET next_attempt_at = $now WHERE status = 'PENDING_REFERENCE' AND wallet_id = $wallet AND provider_id = $provider AND reference_external_transaction_id = $external`. O filtro por `wallet_id` mantém a regra de 5.11 (só mexe em linhas da wallet travada), e precisaria de um índice parcial por `(provider_id, reference_external_transaction_id) WHERE status = 'PENDING_REFERENCE'`. Isso só antecipa o vencimento, sem resolver em linha, e o worker continua sendo o único caminho de resolução. Combinado com um `NOTIFY` para acordar o laço, a latência cairia para milissegundos. Ficou de fora por escopo.

## 9. Consultas e reconciliação

### 9.1 Leituras fora da UnitOfWork de escrita
As consultas de wallet e ledger passam pela porta `WalletQueries` (`SqlWalletQueries`), em SQL explícito, **sem transação de escrita e sem nenhum lock**. Leitura não pode competir com o `FOR UPDATE` da submissão: a unidade de concorrência continua sendo a linha da wallet, e quem só lê nunca a segura. Dinheiro sai como `::text` e viaja como `{amount, currency}`, sem passar pelo domínio (uma consulta não aplica regra, e a `difference` da reconciliação pode ser negativa, o que `Money.from` recusa). A moeda de cada valor vem da wallet. Todos os endpoints de consulta usam o `AuthGuard` no-op (ponto de extensão de autenticação).

### 9.2 Ledger paginado por cursor opaco
`GET /wallets/:walletId/ledger?cursor=&limit=` devolve `{entries, nextCursor}`, ordenado por `wallet_version`.
- **Cursor:** `base64url` da `wallet_version` do último lançamento da página. A decodificação é estrita e exige o round-trip exato: padding (`=`), prefixos (`v:2`), zero, negativos, decimais, notação científica e valores acima de `INTEGER` dão `400 INVALID_CURSOR`. Cursor válido para wallet inexistente dá 404.
- **Limite:** `LEDGER_DEFAULT_PAGE_SIZE` (50) e `LEDGER_MAX_PAGE_SIZE` (100). `limit` não inteiro, zero, negativo ou acima do máximo dá `400 INVALID_LIMIT`, em vez de ser ajustado em silêncio (o cliente não pensa que recebeu a página inteira).
- **Fim da lista:** a query pede `limit + 1` linhas; a linha extra só indica que há próxima página (sem `COUNT`). Na última página `nextCursor` é `null`, inclusive quando o total é múltiplo exato do limite.
- **Por que é estável durante escrita concorrente.** A `wallet_version` de um lançamento é atribuída sob o `FOR UPDATE` da wallet, que só cai no commit. A versão N+1 só pode ser calculada depois do commit da N. Logo nenhuma versão menor que o cursor aparece depois que ele foi emitido: sem entrada repetida e sem entrada perdida. `created_at` não serviria (empata e não é ordenado pelo commit).
- Wallet sem lançamentos: `entries: []` e `nextCursor: null` (um `LEFT JOIN` distingue isso de wallet inexistente numa só instrução).

### 9.3 Consulta de transação
`GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` (a segunda pela chave natural `wt_provider_external_uq`) devolvem o mesmo corpo da submissão, `{transactionId, status, failureCode, balance, idempotentReplay}`, e usam o mesmo mapeamento de erros dos demais endpoints.
- **Status HTTP: sempre 200 quando a transação existe.** O 200/202/422 de 5.9 descreve o **resultado de uma submissão ou de um replay** (o cliente precisa saber, só pelo código, se a operação foi aceita, está pendente ou foi recusada). Numa consulta o pedido em si deu certo: o estado da transação (`status`, `failureCode`, `balance`) é dado do corpo, inclusive para REJECTED e PENDING_REFERENCE. Quem consulta lê o corpo, não o código.
- **`idempotentReplay` é sempre `false`.** Uma consulta não reenvia nada; o campo existe só para o corpo ser idêntico ao da submissão.
- **404 `TRANSACTION_NOT_FOUND`** quando não existe (código legível por máquina, distinto de `WALLET_NOT_FOUND`); a consulta não persiste nada. Ids malformados (`transactionId` fora de UUID) dão 400.
- **OPENING não existe para a API.** É interna (5.6) e nunca entra por ela; por simetria também não sai: a consulta responde 404 (o provider reservado `internal` cai no mesmo caso).
- **Chave natural na rota.** `providerId` e `externalTransactionId` chegam decodificados (`%2F`, espaços, `%25`, `#`, `?`, acentos) e passam pela mesma validação de texto do payload.
- Leitura simples, sem lock, numa transação curta; não decide nada com base no status, então não precisa do lock da wallet (5.1).

### 9.4 Reconciliação
`POST /wallets/:walletId/reconciliation` devolve `{walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries}`. `calculatedBalance` é a soma dos créditos menos os débitos de `wallet_ledger_entries`, **incluindo OPENING**; `difference = storedBalance − calculatedBalance`. Os três valores são `{amount, currency}` (a `difference` pode ser negativa, como `"-7.50"`).
- **Um único instante consistente, sem lock.** Saldo guardado e soma do ledger vêm de **uma só instrução SQL** (`wallets CROSS JOIN LATERAL (SELECT SUM ... FROM wallet_ledger_entries)`). No READ COMMITTED cada instrução enxerga um snapshot único, e a submissão grava wallet e lançamento na mesma transação, então o snapshot vê os dois ou nenhum. Duas leituras separadas (ou uma leitura entre o `UPDATE` da wallet e o commit do lançamento) poderiam apanhar saldo novo com ledger antigo e acusar divergência falsa. REPEATABLE READ também resolveria, mas custaria uma transação explícita sem ganho. A reconciliação **não trava a wallet**: não atrasa apostas nem é atrasada por elas.
- **Aritmética no Postgres.** Soma, diferença e a comparação `balance = calculated` são `NUMERIC`; o JavaScript só repassa strings. Nenhum `number` toca dinheiro.
- **Sempre 200.** A divergência é o resultado da operação (`consistent: false`), não uma falha do pedido. Wallet inexistente: 404; id malformado: 400. É um `POST` porque é uma operação (percorre o ledger e tem efeitos de observabilidade), não um recurso.
- **Divergência não é corrigida.** O ledger é imutável (2.5) e decidir qual lado está certo (saldo ou ledger) é uma decisão humana. O efeito é: log `error` com **apenas** `walletId`, `difference`, `checkedEntries` e `correlationId` (sem saldo guardado, saldo calculado nem payload), o contador `reconciliation_divergences_total` e `consistent: false`. A `difference` no log é o único valor monetário permitido ali, e o teste confere que os saldos não aparecem.
- **Custo: soma o ledger inteiro a cada chamada.** O trabalho é proporcional ao número de lançamentos da wallet (`O(n)`, lendo o ledger da wallet pelo índice de `UNIQUE (wallet_id, wallet_version)`). É aceitável para auditoria sob demanda e reconciliação periódica; não deve ser chamado por requisição de usuário em wallets com histórico enorme. Se virar gargalo: snapshots de saldo por versão (somar só os lançamentos depois do último snapshot) ou rodar a verificação numa réplica de leitura.
- **Depende do `AuthGuard`.** É uma operação cara e de auditoria; hoje o guard é no-op (CLAUDE.md), mas o desenho de produção (CLAUDE.md, "Autenticação") restringiria este endpoint a um papel operacional/de auditoria no token, e não ao jogador ou ao provedor. Sem o guard real, qualquer cliente que conheça um `walletId` poderia disparar a soma do ledger inteiro.

### 9.5 Testes de consultas e reconciliação
Postgres real; todos terminam com `wallet.balance == saldo reconstruído pelo ledger` e com um `afterEach` que falha se algum log trouxer valor monetário.
- `ledger-cursor.test.ts` (unidade): round-trip, formato opaco e todos os cursores recusados.
- `wallet-queries-http.test.ts`: forma do lançamento (ISO-8601, `{amount, currency}`), paginação, `nextCursor` nulo (inclusive em múltiplo exato do limite), wallet sem lançamentos, 400 para cursor e `limit` inválidos, 404, e **paginação sob escrita concorrente** (60 apostas em lotes de 6 enquanto o leitor pagina de 4 em 4: as versões lidas são exatamente `1..61`, sem repetição nem buraco).
- `transaction-queries-http.test.ts`: 200 para PROCESSED, REJECTED e PENDING_REFERENCE; 404 `TRANSACTION_NOT_FOUND`; OPENING invisível; `externalTransactionId` e `providerId` com `/`, espaço, `%`, `?`, `#`, `+` e acento.
- `reconciliation-http.test.ts`: consistente após BET/WIN/REFUND (com OPENING), LOSS, wallet sem lançamentos, 404/400, **divergência provocada por `UPDATE wallets.balance`** (o ledger não pode ser alterado; o teste restaura o saldo num `finally`), diferença negativa, e **reconciliação em paralelo com 90 apostas** sem nenhuma divergência falsa, nenhum log `error` e contador intacto.
- Nota: no teste de divergência o log `error` contém a `difference` (por exemplo `5.25`), que casaria com o detector de valor monetário do `afterEach`; o teste valida o conteúdo exato do log e depois limpa o logger capturado, em vez de afrouxar o detector para todos os outros testes.

## 10. Health checks e múltiplas instâncias

### 10.1 `/health/live` e `/health/ready`
Os dois são abertos, sem `AuthGuard` (CLAUDE.md, "Autenticação").
- **`/health/live`** responde 200 se o processo atende HTTP e **não toca nenhuma dependência**. Se o liveness consultasse o banco, uma queda do Postgres faria o orquestrador reiniciar todas as instâncias ao mesmo tempo, sem nenhum ganho: o problema não está no processo.
- **`/health/ready`** confere as dependências sem as quais a instância não deve receber tráfego: `SELECT 1` por uma conexão do pool (`postgres`), `GetQueueAttributes` da fila de eventos (`sqs-events`) e, **só se o consumidor estiver ligado**, da fila de transações e da DLQ (`sqs-transactions`, `sqs-transactions-dlq`). Responde 200 `{status:'ok', checks}` ou 503 `{status:'unavailable', checks}`, com `ok`/`down` por check. O 503 tira a instância do balanceamento sem matá-la.
- **Teto por check** (`READINESS_TIMEOUT_MS`, 2 s), em paralelo, aplicado com `Promise.race` mais `AbortSignal`. O driver do Postgres não aceita sinal, e um banco que aceita a conexão e não responde penduraria o health check (teste com um socket que nunca responde).
- **Sem texto livre:** a resposta traz só o nome de cada check, e o log `warn` traz só o nome do probe e o nome do erro, nunca a mensagem (mesmo critério de 7.3).
- Uma falha de readiness não para os workers: eles já tratam a falha de cada ciclo (6.5, 7.4, 8.4) e voltam sozinhos quando a dependência volta.

Testes: `health-http.test.ts` (tudo ok; com o consumidor ligado, também as filas dele; fila inexistente; Postgres com conexão recusada; Postgres que nunca responde, cortado no teto) e `readiness.test.ts` (unidade: teto mesmo com probe que ignora o sinal).

### 10.2 Testes multi-instância, crash e reinício
`multi-instance.test.ts` (também `bun run test:multi-instance`) sobe **três processos reais** da aplicação (`bun src/main.ts` via `Bun.spawn`), com portas distintas, o mesmo Postgres e o mesmo LocalStack, e publisher, consumidor e worker de pendentes ligados em todos. O pai recria o schema, cria filas FIFO temporárias (transações com DLQ e redrive 15, e eventos com os mesmos atributos da `wager-events.fifo`, para a contagem de eventos não se misturar com outros testes ou com o `start:dev`) e espera o `/health/ready` de cada filho, com prazo.

**Identidade da instância.** Cada filho recebe `INSTANCE_ID` e o devolve no header `X-Instance-Id` de **toda** resposta, inclusive as de erro. O consumidor o grava no log de cada mensagem (`instanceId`). O mesmo valor vai em `PGAPPNAME`, o `application_name` da sessão no Postgres. O driver lê essa variável do ambiente, e o MikroORM descarta parâmetros na URL. Com isso o teste prova que cada instância atendeu HTTP e consumiu mensagens, e enxerga as transações de cada uma no `pg_stat_activity`. Fora dos testes, o header e o campo de log servem de diagnóstico; nada decide com base neles.

**Configuração dos filhos.** Pool de 15 (consumidor 5 + publisher 1 + pendentes 4 = 10 = 15 − 5, 8.5). Três filhos mais o pool do pai ficam abaixo do `max_connections` real do Postgres do compose (100, com 3 reservadas), o que o `beforeAll` confere. `lock_timeout` de 3 s e visibilidade de 12 s, que fica acima do orçamento de 8 s (7.4), de modo que a mensagem que estava com a instância morta volta em segundos. Backoff de pendentes curto (100 ms a 500 ms).

**Cenários:** duas apostas de 80 sobre 100 em instâncias diferentes, em 20 wallets; a mesma aposta 50 vezes espalhada nas três; 9 wallets em paralelo por HTTP e pela fila; REFUND numa instância antes da BET em outra (202 e depois PROCESSED, consultado numa terceira); **crash** de uma instância no meio da carga; **reinício completo**, em que as três morrem no meio da carga, a fila recebe mais mensagens e redeliveries (mesmo `messageId`) com tudo parado, e três novas sobem sobre o mesmo banco.

**"No meio da carga" é medido, não cronometrado.** Antes do kill o teste exige três sinais da própria instância: ela já respondeu requisições desta carga, ainda tem requisições do pai sem resposta e tem uma transação de submissão aberta no Postgres (`pg_stat_activity` filtrado pelo `application_name`, sem os ticks ociosos da outbox e da listagem de pendentes). Mensagens em voo na fila são registradas, mas não bastam sozinhas, porque podem estar com outra instância. Se os sinais não aparecem no prazo, a carga é repetida (até 3 rodadas).

**Cliente com failover.** Uma requisição que falha com erro de rede tem resultado desconhecido: a instância pode ter commitado e morrido antes de responder. O cliente do teste reenvia a **mesma** requisição, com a mesma `Idempotency-Key`, a outra instância viva, e a resposta pode ser nova ou replay. No reinício completo, o que ficou sem resposta é reenviado às instâncias novas.

**Fechamento de todo cenário:** `balance == ledger`; saldo, versão e número de lançamentos de cada wallet iguais aos esperados (calculados com o `Money` do domínio); outbox sem pendentes; a fila de eventos é drenada (recebe, apaga cada mensagem e repete até 3 leituras vazias, com prazo) e cada `eventId` aparece **exatamente uma vez**, conjunto igual ao da outbox (a dedup do LocalStack vale dentro da janela de 5 min, 6.1, e o arquivo roda em cerca de 1 min); zero 5xx; `X-Instance-Id` igual à instância chamada; fila de transações e DLQ vazias; e nenhum `40P01`, `deadlock detected` ou nome de constraint, índice único ou trigger do schema nos logs (stdout e stderr) de nenhum filho. No crash e no reinício, cada aposta lógica existe uma única vez e PROCESSED, e a inbox tem uma linha por `messageId` distinto. No reinício, o teste também espera o Postgres soltar as sessões das instâncias mortas antes de subir as novas.

**SIGTERM no Windows não é confiável; o crash é um kill forçado.** No Windows não há entrega de SIGTERM entre processos: `child.kill()` do Bun chama `TerminateProcess`, e o processo morre sem rodar nenhum hook. É exatamente o crash que se quer simular (equivalente a SIGKILL; no Linux o helper manda `SIGKILL` explicitamente). O sistema operacional fecha os sockets, o Postgres desfaz as transações abertas e solta os locks, e as mensagens sem ack voltam pela visibilidade. O shutdown **gracioso** (SIGTERM, ou `app.close()`, que percorre os mesmos hooks) continua coberto pelos testes de 6.5, 7.7 e 8.6. Os filhos são mortos no `afterAll` e também num handler de `process.on('exit')`, para não sobrar processo se o teste abortar.

**Exceção na varredura de logs.** De um filho morto à força, a última linha de stdout e de stderr pode ter sido cortada no meio da escrita e é ignorada. Todo o resto do que ele escreveu passa pela mesma varredura.

**Porta ocupada.** A porta livre é escolhida antes do spawn, e outro processo pode tomá-la nesse intervalo. Se o filho morre com `EADDRINUSE` antes de ficar pronto, o helper tenta de novo com outra porta (até 3 vezes).

## 11. Observabilidade e autenticação

### 11.1 Autenticação: `AuthGuard` no-op como ponto de extensão
Autenticação não faz parte do escopo (CLAUDE.md), mas o ponto de extensão é explícito: `AuthGuard` (`src/interface/http/auth.guard.ts`) é aplicado com `@UseGuards` **no nível da classe** em todo controller de negócio (`WalletsController`, `WageringTransactionsController`, `ProviderTransactionsController`), o que cobre `POST /wallets` e `POST /wagering/transactions`. Hoje ele devolve `true`. Trocar a implementação protege todas as rotas de uma vez, sem tocar nos controllers.

**Garantia por teste.** `auth-guard-coverage.test.ts` descobre os controllers no `ModulesContainer` do Nest (não há lista manual) e falha se algum, fora da allowlist explícita `HealthController` e `MetricsController`, não tiver o guard. Um controller novo esquecido quebra o teste.

**Desenho de produção (não implementado).** IdP externo (Keycloak ou Zitadel) com OIDC: o guard valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e deriva o `providerId` do token (claim dedicada), de modo que o provedor deixa de ser informado no corpo e um token não escreve em nome de outro provedor. Papéis no token separam o provedor (submissão e consulta das próprias transações) de um papel operacional (reconciliação, 9.4, que é cara). No consumidor SQS a autorização é a da fila (IAM), não o JWT.

**`/health/*` e `/metrics` ficam abertos**, para orquestrador e scraper funcionarem sem credencial. `/metrics` expõe volumes e nomes de rotas e **não deve ser exposto publicamente**: em produção fica numa rede interna ou atrás de um listener/porta separado, ou do ingress com allowlist de origem.

### 11.2 Logs: JSON em stdout e nada de texto livre de erro
**Formato.** `JsonLogger` (`LoggerService` do Nest, default do `createApp`) escreve uma linha JSON por entrada em stdout: `timestamp`, `level` (`info|warn|error|debug|verbose|fatal`), `context`, `message` e os campos de correlação quando existem (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`). Os campos reservados vencem os do log. O logger de aplicação (`NestStructuredLogger`) passa o objeto direto, sem `JSON.stringify` no meio. O stack que o Nest manda em `error(message, stack, context)` é **descartado**: só o último parâmetro vira `context`, e só se casar com `/^[A-Za-z][\w.-]{0,63}$/` (um stack, mesmo sozinho, nunca casa). Valores não serializáveis (ciclo, `bigint`) não derrubam o logger.

**`describeError` é uma whitelist, não um filtro.** Um erro só chega ao log por `errorFields(error)` (ou `describeError`), que devolve apenas campos de formato fechado: `errorName` (`/^[A-Za-z][\w$]{0,63}$/`), `sqlState` (5 caracteres com ao menos um dígito), `code` (`/^[A-Z][A-Z0-9_]{1,31}$/`, como `ECONNRESET`), `constraint` (`/^[a-z0-9_]{1,63}$/`) e os frames `at ...` do stack (no máximo 10, de 200 caracteres). Nunca a `message`, o `detail` do erro do pg, a query do MikroORM nem os parâmetros. O que não casa com o formato some. `cause` e `AggregateError.errors` passam pelo mesmo filtro, com profundidade 3 e no máximo 5 causas, com proteção contra ciclo; todo acesso a propriedade é protegido (getter que lança). Um throwable que não é `Error` não é stringificado: vira `NonError_<typeof>`.

**Frames.** A primeira parte do `stack` repete `nome: mensagem`, e a mensagem pode ter várias linhas, até `\n    at 100.00 (a:1:1)` forjado. O cabeçalho só é removido se o stack **começa exatamente** por `nome + ": " + mensagem` (aceitando também `Error` e o nome da classe, porque `this.name = ...` depois do `super()` não muda o cabeçalho já capturado); a remoção é pelo tamanho, então as linhas forjadas da mensagem saem junto. Se o stack não começa assim, não há frames. A mensagem só serve para medir o que descartar.

**O 503 e o motivo da DLQ.** O corpo do 503 tem mensagem fixa (`Service temporarily unavailable`). O `failureReason` e o `failureDetail` da mensagem na DLQ vêm de um conjunto fechado (`FailureReason`: `InvalidMessageReason`, `ApplicationErrorCode` ou `UNEXPECTED_ERROR`), nunca de `error.message`; o detalhe do validador (`InvalidMessageError.details`) deixou de ir para a DLQ e continua só no corpo 400 do HTTP. Quando a mensagem estoura as tentativas, o detalhe é o SQLSTATE (formato validado) ou o motivo fechado. Nenhum log recebe `Idempotency-Key` nem `externalTransactionId`.

**Fora do alcance do logger.** Um crash dump do runtime (falha fatal do Bun/JS) escreve em stderr direto, sem passar por `JsonLogger`; o log dessa saída é responsabilidade do orquestrador, e a varredura do `multi-instance` (6) olha stdout e stderr. O mesmo vale para o que um módulo de terceiros imprima por conta própria.

**Garantias por teste.**
- Unidade: `describe-error.test.ts` (mensagem com valor, frames forjados, mensagem alterada, stack reescrito, erro do pg com `detail`/query, cause, `AggregateError`, ciclo, getter que lança, throwable não-Error, erro real do Bun com ao menos um frame), `json-logger.test.ts` e `http-error-filter-log.test.ts`.
- **Prova de mutação do filtro HTTP:** trocar o log por `e.message`/`e.stack` (em outra chave, já que `message` é reservada) quebra 2 dos 3 testes do filtro; o código restaurado passa.
- **Rede de runtime (principal):** o `afterEach` "nenhum valor monetário em log" cobre os testes de HTTP (submissão, reversões, wallets, consultas, reconciliação), do publisher da outbox, do worker de pendentes e do consumidor, mais um POST com JSON inválido contendo `"amount":"123.45"`.
- **Rede secundária por varredura de `src/`** (`logging-audit.test.ts`): nenhum argumento de chamada de logger contém `.message`, `.stack` ou uma variável de `catch` fora de `errorFields`/`describeError`. Não é uma AST: o `typescript` 7 não expõe a API de compilador em JS, e não se adiciona dependência para isto. É um varredor de texto com comentários e strings mascarados e parênteses balanceados, autoverificado com exemplos que ele deve acusar e aceitar. O escopo de uma variável de catch é o arquivo (pode acusar de mais, nunca de menos), e um erro repassado por variável intermediária não é visto; para isso vale a rede de runtime.

### 11.3 Middleware de requisição, `correlationId` e contexto de log
**Contexto mutável em `AsyncLocalStorage`** (`request-context.ts`). O middleware (HTTP) ou o consumidor (uma mensagem SQS) abre o contexto com o `correlationId`; quem descobre os ids depois (`walletId`, `providerId`, `transactionId`, `messageId`) os preenche com `enrichContext`, **no mesmo objeto, sem novo `run`**. Todo log feito por `NestStructuredLogger` dentro do fluxo carrega os campos preenchidos (um campo passado explicitamente vence o do contexto). No HTTP, os controllers preenchem os ids **depois de validá-los** (UUID ou identificador do validador), nunca a string crua da URL. No consumidor, cada mensagem roda no seu contexto, com o id da mensagem SQS até a leitura e `correlationId = messageId` a partir daí (o mesmo valor que o use case grava no evento da outbox).

**`correlationId` (HTTP).** O `X-Correlation-Id` do cliente só é aceito com `/^[A-Za-z0-9._:-]{1,64}$/`; senão (grande demais, espaço, aspas, quebra de linha, repetido) é descartado e um id é gerado pelo `IdGenerator`. O id vai no header de resposta `X-Correlation-Id`, na linha de log e, via `correlationIdFrom`, no evento da outbox: é o mesmo valor nos três. Um header válido não consome o gerador (os testes que enfileiram ids dependem disso).

**Linha da requisição.** Ao terminar a resposta, uma linha `http request`: `method` (conjunto conhecido, senão `OTHER`), `route` (o **template** de `request.route.path`, como `/wallets/:walletId/ledger`; `unmatched` se nenhuma rota casou), `status`, `durationMs` **inteiro** e os ids do fluxo. Nunca corpo, query, `Idempotency-Key` nem a URL real (uma rota inexistente não escreve o que o cliente pediu). Duração inteira porque `12.34` pareceria um valor monetário aos testes de vazamento. Nível: `info` até 4xx, `error` em 5xx, `warn` se o cliente aborta. Requisição abortada (`close` sem `finish`) é gravada com `status = 499`: **convenção própria**, emprestada do nginx ("client closed request"), e não um código HTTP do padrão. Nenhuma resposta 499 é enviada; o número só existe no log e no label `status` das métricas (11.4), para separar "o cliente desistiu" de qualquer código que o servidor tenha respondido. O filtro de erros só loga 5xx (11.2); 4xx e 422 aparecem **só** nesta linha, e as métricas por status (11.4) saem do mesmo ponto.

**Ruído.** `/health/*` e `/metrics` são logados em `debug`, que o `JsonLogger` suprime a menos que `LOG_LEVEL=debug` (ou `verbose`); o padrão é `info`.

**Adapter.** O projeto usa `@nestjs/platform-express`, onde a rota casada está em `request.route.path` (no Fastify seria `request.routeOptions.url`). `createApp` recusa subir com outro adapter, em vez de gravar `unmatched` em silêncio. O middleware é o **primeiro** da pilha: abre o contexto antes dos parsers. Sob o Bun o contexto atravessa o `body-parser` (conferido num experimento e pelo teste de integração, que lê o `correlationId` no log do filtro de erros, que roda depois do corpo ser lido); em Node isso não é garantido, e o fallback seria um interceptor global.

Testes: `request-logging.middleware.test.ts` (unidade: header válido e inválido, template, método, ids preenchidos no meio do fluxo, nível, `LOG_LEVEL`, contextos concorrentes) e `request-logging-http.test.ts` (Nest, Express, Postgres e LocalStack reais: o mesmo `correlationId` no log, no header e no evento da outbox; requisições em paralelo; 404 `unmatched`; 409 e 422 na linha; `/health` só em `debug`; 5xx do filtro com o mesmo `correlationId`; consumidor com `correlationId = messageId`).

### 11.4 `GET /metrics` e a lista de métricas
**Exposição.** `GET /metrics` devolve o formato texto do Prometheus (0.0.4), sem `AuthGuard` (11.1): não deve ser exposto publicamente. O registro (`InMemoryMetrics`) é **por instância**; a instância é identificada pelo rótulo do próprio scrape (não há label `instance` nas métricas, e `X-Instance-Id` não entra). Escrito à mão, sem `prom-client`: três tipos (counter, gauge, histogram), `# HELP`/`# TYPE` uma vez por família, histogramas com buckets cumulativos (5 ms a 10 s, `+Inf` igual a `_count`), `_sum`, `_count` e escape de `\`, `"` e quebra de linha nos valores de label. O teste usa um **parser estrito** (`test/support/prometheus-parser.ts`) que rejeita TYPE duplicado, família que volta, série repetida, label malformado, bucket fora de ordem ou não cumulativo, `+Inf` diferente de `_count`.

**Lista mínima e onde cada métrica nasce:**
| Métrica | Onde | Observação |
|---|---|---|
| `wager_transactions_total{status,kind}` | `SubmitWagerTransaction` e `ResolvePendingReference`, **depois do commit** | Conta a **transição** para PROCESSED, REJECTED ou PENDING_REFERENCE, inclusive as resolvidas pelo worker de pendentes. Replay e duplicata não contam. `wager_rejections_total{failure_code}` acompanha. |
| `wager_duplicates_total{source=http\|sqs,level}` | `SubmitWagerTransaction` | Duplicata = replay com a mesma chave e o mesmo payload (inclui perder a corrida do `ON CONFLICT`) ou a mesma mensagem da fila reentregue. `level` separa `idempotency_key` de `inbox`. Substitui `sqs_consumer_duplicates_total`. |
| `wager_idempotency_conflicts_total{kind}` | `SubmitWagerTransaction` | O 409 (mesma chave com payload diferente, id externo ou messageId) **não** é duplicata; tem contador próprio. |
| `db_lock_conflicts_total{sqlstate=55P03\|40P01}` | `MikroOrmUnitOfWork`, **único ponto** | `lock_timeout` e deadlock. Incrementa quando o UoW vê o erro cru do driver e o embrulha em `TransientInfrastructureError`; HTTP, consumidor e workers só veem o erro já embrulhado e não contam de novo. Um retry do consumidor é outra execução, outro conflito real. |
| `http_requests_total` e `http_request_duration_seconds{method,route,status}` | middleware da linha de requisição | Do mesmo ponto do log, então contam 409, 422 e 4xx em geral, que o filtro de erros não loga. Requisição abortada (`close` sem `finish`) entra **uma vez**, com `status="499"`. |
| `sqs_consumer_processing_seconds` | consumidor | Histograma da latência de uma mensagem. |
| Retries | `outbox_retries_total`, `sqs_consumer_retries_total`, `pending_reference_retries_total` | Já existiam. |
| Mensagens na DLQ | `sqs_consumer_dlq_total{reason}` | Contador do que **esta** instância moveu. A profundidade da DLQ é uma consulta ao SQS (`ApproximateNumberOfMessages`) que o `/metrics` não faz: o scrape não depende do SQS. |
| `outbox_lag_seconds` | calculado **no scrape** | Idade da linha pendente mais antiga da outbox. É **global** (o mesmo valor em toda instância, porque lê o banco): agregar com `max`, não com `sum`. Se o banco não responde (teto de 2 s), a métrica é **omitida** (um valor velho esconderia o problema) e `metrics_scrape_degraded_total{source="outbox_lag"}` sobe; o resto do scrape continua. Custo controlado, ver abaixo. |

**Custo do lag no scrape.** O scrape não pode competir com o tráfego de negócio pelo pool:
- **cache de 5 s** (`LAG_CACHE_TTL_MS`, pelo `Clock` da aplicação) da leitura (`min(occurred_at)` das pendentes), e não do lag: o gauge é `now − oldest` na hora do scrape e continua andando entre leituras. Se a linha mais antiga for publicada, o valor fica errado por no máximo 5 s. A falha também fica em cache: com o banco fora do ar, scrapes seguidos não insistem, e `metrics_scrape_degraded_total` conta **consultas** que falharam, não scrapes;
- **single-flight**: scrapes simultâneos aguardam a mesma consulta (a `Promise` em andamento, limpa em `finally`);
- **`SET LOCAL statement_timeout = 2 s`** (opção `statementTimeoutMs` do UoW) na transação da leitura: o banco cancela a consulta (por exemplo, esperando um lock de tabela) e a conexão volta ao pool. O `Promise.race` de 2 s continua, porque cobre também a espera por uma conexão do pool, que o `statement_timeout` não alcança.

Teste (`metrics-http.test.ts`): outra conexão segura `LOCK TABLE outbox IN ACCESS EXCLUSIVE MODE`; dois scrapes simultâneos omitem o gauge, a degradação conta 1, e nenhuma sessão continua esperando pela consulta em `pg_stat_activity` (sem o `SET LOCAL` ela esperaria o `lock_timeout` de 10 s; **prova de mutação**: removido, o teste falha).

**Varredura de dados monetários.** A regex `MONETARY` dos logs é aplicada ao nome de cada família, ao HELP, ao nome da série e aos nomes e valores de label, menos o `le` dos buckets e o valor numérico das amostras (um `_sum` de `0.01` s casaria). Zero amostras lidas falha o teste (não passa em vazio). **Prova de mutação**: um contador com `amount="100.00"` injetado no controller quebra o teste; um teste fixo com exposição sintética mantém essa prova.

**Labels limitados.** `method` do conjunto conhecido, senão `OTHER`; `route` é o template da rota ou `unmatched` (40 URLs inexistentes viram uma série); `status` é o código de três dígitos. Nenhum `providerId`, `walletId`, `transactionId` ou `messageId` é label (um teste varre `src/`, `metrics-audit.test.ts`); esses ids vão para os logs (11.3).

**Auditoria das métricas que já existiam.** Faltavam: transações por status, duplicatas fora do consumidor, conflitos de lock, e a latência HTTP. O lag da outbox existia como gauge do publisher, mas ficava velho se o laço parasse; passou a ser calculado no scrape. O `summary` (contagem, soma, máximo) virou histograma.

**Limitação.** O registro é em memória: um restart zera os contadores (o Prometheus trata como reset). Sem push nem agregação entre instâncias.

Testes: `prometheus.test.ts` e `metrics-audit.test.ts` (unidade), `lock-conflict-metric.test.ts` (classificação 55P03/40P01) e `metrics-http.test.ts` (Nest, Express e Postgres reais: exposição estrita, contagens exatas, 409/422/404/400, histograma fechando com a contagem, labels limitados, abortada contada uma vez, 55P03 real com `lock_timeout` curto, transição pelo worker de pendentes, lag no scrape e banco fora do ar).
