import { Migration } from '@mikro-orm/migrations';

const CODES_BEFORE = `'INSUFFICIENT_FUNDS','REVERSAL_WOULD_OVERDRAW','REFERENCE_NOT_FOUND','REFERENCE_NOT_PROCESSED',
        'REFERENCE_MISMATCH','ALREADY_REVERSED','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
        'INVALID_REFERENCE_KIND','INTERNAL_ERROR'`;

/**
 * Fatia 4 (ARCHITECTURE 5.6 e 5.7):
 * 1. Novo failure_code PLAYER_MISMATCH: transação de um player para a wallet de outro.
 * 2. provider_id 'internal' é reservado para a OPENING, e a OPENING só existe com ele.
 */
export class Migration20261017000003_player_mismatch_and_internal_provider extends Migration {
  override name = 'Migration20261017000003_player_mismatch_and_internal_provider';

  override up(): void {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wt_failure_code_valid`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wt_failure_code_valid CHECK (failure_code IS NULL OR failure_code IN (
        ${CODES_BEFORE},'PLAYER_MISMATCH'))`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wt_internal_provider_only_opening CHECK (
        (provider_id = 'internal') = (kind = 'OPENING'))`);
  }

  override down(): void {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wt_internal_provider_only_opening`);
    // O código novo não existe no CHECK antigo: linhas já gravadas viram REFERENCE_MISMATCH (perda de detalhe).
    this.addSql(
      `UPDATE wager_transactions SET failure_code = 'REFERENCE_MISMATCH' WHERE failure_code = 'PLAYER_MISMATCH'`,
    );
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wt_failure_code_valid`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wt_failure_code_valid CHECK (failure_code IS NULL OR failure_code IN (
        ${CODES_BEFORE}))`);
  }
}
