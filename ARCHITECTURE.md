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
| `REFERENCE_NOT_FOUND` | REJECTED | referência não apareceu dentro do limite de tentativas |
| `REFERENCE_NOT_PROCESSED` | REJECTED | a referência existe, mas terminou `REJECTED` ou `FAILED`: não há efeito a reverter |
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
- **Latência até o próximo ciclo do worker.** Quando a referência chega, a reversão pendente **não** é resolvida na mesma requisição: ela espera o próximo ciclo do worker (fatia 8), limitado por `next_attempt_at`. Resolver em linha deixaria o caminho da submissão mais complexo e duplicaria o worker; o custo é a reversão ficar visível como pendente por até um intervalo de backoff.

### 5.11 `ResolvePendingReference` e a ordem de locks
Use case que reavalia **uma** transação `PENDING_REFERENCE`. É o núcleo do worker da fatia 8, que vai acrescentar o agendamento, o `SKIP LOCKED` e o limite de tentativas. Uma transação SQL:
1. lê a linha **sem lock**, só para descobrir o `walletId` (imutável);
2. `SELECT ... FOR UPDATE` na wallet;
3. **relê a linha sob o lock** e termina como **no-op** se ela já não está `PENDING_REFERENCE` (outra instância resolveu antes);
4. aplica as mesmas regras da submissão (5.10) e faz `UPDATE ... WHERE id = ? AND status = 'PENDING_REFERENCE'`, mais ledger, saldo e outbox, na mesma transação. Os eventos são os mesmos do caminho normal (`WagerTransactionProcessed` ou `Rejected`, e `WalletBalanceChanged` se o saldo mudou). Se a referência continua ausente, só conta a tentativa (`attempts + 1`, `next_attempt_at = now + backoff(attempts + 1)`), sem evento.

O UPDATE confere as linhas afetadas, e algo diferente de 1 lança erro e desfaz a transação. Esse erro é só para o caso impossível: a releitura sob o lock já garantiu que a linha está pendente. Uma corrida entre dois resolves termina com um aplicando e o outro em no-op, sem erro (teste `reversal-concurrency.test.ts`).

**Ordem de locks (regra do sistema): wallet primeiro, sempre.** Todo caminho que muda uma `wager_transaction` ou o saldo trava a linha da wallet **antes** de qualquer outro lock de linha. Isso vale para submissão, resolve e worker. O worker da fatia 8 **não pode** travar a linha da transação (por exemplo, com `FOR UPDATE SKIP LOCKED` em `wager_transactions`) e depois a wallet: a submissão faz wallet → transação, e a ordem invertida reabre o ciclo de deadlock de 5.1. O worker deve **selecionar candidatos sem segurar o lock da transação**, ou usar `SKIP LOCKED` só numa transação curta de "reserva" que termina antes de travar a wallet, e então chamar este use case, que trava na ordem certa. Pela mesma razão, todo UPDATE em `wager_transactions` acontece sob o lock da wallet, o que é a premissa da leitura sem lock em 5.10.
