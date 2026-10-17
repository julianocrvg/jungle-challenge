import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes financeiras ficam no banco (restrição 9):
 * unicidade (idempotência, wallet por player+moeda, ledger por transação e por versão),
 * não-negatividade (saldo e balance_after) e imutabilidade do ledger (trigger).
 * SQL escrito à mão porque o gerador do ORM não cobre índices parciais, CHECKs compostos e triggers.
 */
export class Migration20261017000001_initial_schema extends Migration {
  override name = 'Migration20261017000001_initial_schema';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          UUID PRIMARY KEY,
        player_id   UUID          NOT NULL,
        currency    CHAR(3)       NOT NULL,
        balance     NUMERIC(19,2) NOT NULL,
        version     INTEGER       NOT NULL DEFAULT 1,
        created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
        CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),
        -- alvo da FK composta do ledger: garante que o lançamento tem a moeda da wallet
        CONSTRAINT wallets_id_currency_uq       UNIQUE (id, currency),
        CONSTRAINT wallets_currency_format      CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                UUID PRIMARY KEY,
        provider_id                       TEXT          NOT NULL,
        external_transaction_id           TEXT          NOT NULL,
        idempotency_key                   TEXT          NOT NULL,
        payload_hash                      CHAR(64)      NOT NULL,
        wallet_id                         UUID          NOT NULL REFERENCES wallets (id),
        player_id                         UUID          NOT NULL,
        round_id                          TEXT,
        game_id                           TEXT,
        kind                              TEXT          NOT NULL,
        amount                            NUMERIC(19,2) NOT NULL,
        currency                          CHAR(3)       NOT NULL,
        reference_external_transaction_id TEXT,
        reference_transaction_id          UUID REFERENCES wager_transactions (id),
        status                            TEXT          NOT NULL,
        failure_code                      TEXT,
        balance_after                     NUMERIC(19,2),
        attempts                          INTEGER       NOT NULL DEFAULT 0,
        next_attempt_at                   TIMESTAMPTZ,
        created_at                        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        processed_at                      TIMESTAMPTZ,

        CONSTRAINT wt_idempotency_key_uq   UNIQUE (idempotency_key),
        CONSTRAINT wt_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        -- alvo da FK composta do ledger: lançamento e transação apontam para a mesma wallet
        CONSTRAINT wt_id_wallet_uq         UNIQUE (id, wallet_id),

        CONSTRAINT wt_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wt_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wt_failure_code_valid CHECK (failure_code IS NULL OR failure_code IN (
          'INSUFFICIENT_FUNDS','REVERSAL_WOULD_OVERDRAW','REFERENCE_NOT_FOUND','REFERENCE_MISMATCH',
          'ALREADY_REVERSED','AMOUNT_MISMATCH','CURRENCY_MISMATCH','INVALID_REFERENCE_KIND','INTERNAL_ERROR')),
        CONSTRAINT wt_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wt_attempts_non_negative CHECK (attempts >= 0),

        -- valor positivo; zero só é aceito para LOSS (registra o resultado sem mover saldo)
        CONSTRAINT wt_amount_valid CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),

        -- rodada e jogo só são dispensados na abertura interna da wallet
        CONSTRAINT wt_round_game_required CHECK (
          kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)),

        -- REFUND/ROLLBACK exigem referência; OPENING/BET não podem ter; WIN/LOSS é opcional
        CONSTRAINT wt_reference_by_kind CHECK (
          CASE
            WHEN kind IN ('REFUND','ROLLBACK') THEN reference_external_transaction_id IS NOT NULL
            WHEN kind IN ('OPENING','BET') THEN reference_external_transaction_id IS NULL
                                                AND reference_transaction_id IS NULL
            ELSE TRUE
          END),

        -- reversão aplicada precisa ter a referência resolvida para o id interno
        CONSTRAINT wt_processed_reversal_resolved CHECK (
          NOT (kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED' AND reference_transaction_id IS NULL)),

        -- failure_code existe exatamente nos estados de falha
        CONSTRAINT wt_failure_code_status CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),

        -- estados terminais têm processed_at; os demais não
        CONSTRAINT wt_terminal_processed_at CHECK (
          (status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),

        -- replay devolve o saldo observado: obrigatório em PROCESSED e REJECTED
        CONSTRAINT wt_balance_after_terminal CHECK (
          status NOT IN ('PROCESSED','REJECTED') OR balance_after IS NOT NULL),
        CONSTRAINT wt_balance_after_non_negative CHECK (balance_after IS NULL OR balance_after >= 0)
      )`);

    // Dupla reversão: uma referência só pode ser revertida uma vez por tipo (REFUND ou ROLLBACK).
    // Parcial em PROCESSED: reversões rejeitadas ficam auditáveis sem bloquear uma tentativa legítima.
    this.addSql(`
      CREATE UNIQUE INDEX wt_single_reversal_uq
        ON wager_transactions (reference_transaction_id, kind)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);

    // Worker de PENDING_REFERENCE: busca as vencidas sem varrer a tabela inteira.
    this.addSql(`
      CREATE INDEX wt_pending_reference_due_idx
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);

    this.addSql(`CREATE INDEX wt_wallet_created_idx ON wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             UUID PRIMARY KEY,
        wallet_id      UUID          NOT NULL,
        transaction_id UUID          NOT NULL,
        wallet_version INTEGER       NOT NULL,
        direction      TEXT          NOT NULL,
        amount         NUMERIC(19,2) NOT NULL,
        currency       CHAR(3)       NOT NULL,
        balance_before NUMERIC(19,2) NOT NULL,
        balance_after  NUMERIC(19,2) NOT NULL,
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),

        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),
        CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),

        -- no máximo um lançamento por transação por wallet
        CONSTRAINT ledger_wallet_transaction_uq UNIQUE (wallet_id, transaction_id),
        -- cada versão da wallet corresponde a um único lançamento; base do cursor de paginação
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),

        CONSTRAINT ledger_wallet_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount))
      )`);

    // Imutabilidade estrutural do ledger: UPDATE, DELETE e TRUNCATE falham, inclusive para o owner.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_entries_forbid_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $fn$`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_forbid_mutation()`);
    this.addSql(`
      CREATE TRIGGER wallet_ledger_entries_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wallet_ledger_entries_forbid_mutation()`);

    this.addSql(`
      CREATE TABLE inbox (
        consumer_name TEXT        NOT NULL,
        message_id    TEXT        NOT NULL,
        payload_hash  CHAR(64)    NOT NULL,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        processed_at  TIMESTAMPTZ,
        CONSTRAINT inbox_pk PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox (
        id              UUID PRIMARY KEY,
        aggregate_id    UUID        NOT NULL,
        event_type      TEXT        NOT NULL,
        payload         JSONB       NOT NULL,
        occurred_at     TIMESTAMPTZ NOT NULL,
        attempts        INTEGER     NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at    TIMESTAMPTZ,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      )`);
    this.addSql(`CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at) WHERE published_at IS NULL`);
  }

  override down(): void {
    // Ordem inversa das dependências. Os triggers caem junto com a tabela.
    this.addSql(`DROP TABLE outbox`);
    this.addSql(`DROP TABLE inbox`);
    this.addSql(`DROP TABLE wallet_ledger_entries`);
    this.addSql(`DROP FUNCTION wallet_ledger_entries_forbid_mutation()`);
    this.addSql(`DROP TABLE wager_transactions`);
    this.addSql(`DROP TABLE wallets`);
  }
}
