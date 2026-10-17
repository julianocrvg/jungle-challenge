import { Migration } from '@mikro-orm/migrations';

/**
 * Duas correções de interpretação sobre o schema inicial:
 * 1. Uma referência só pode ser revertida UMA vez no total, por qualquer tipo (REFUND ou ROLLBACK).
 *    O índice passa de (reference_transaction_id, kind) para (reference_transaction_id).
 * 2. Novo failure_code REFERENCE_NOT_PROCESSED: a referência existe, mas terminou REJECTED ou FAILED.
 */
export class Migration20261017000002_single_reversal_and_reference_not_processed extends Migration {
  override name = 'Migration20261017000002_single_reversal_and_reference_not_processed';

  override up(): void {
    this.addSql(`DROP INDEX wt_single_reversal_uq`);
    this.addSql(`
      CREATE UNIQUE INDEX wt_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);

    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wt_failure_code_valid`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wt_failure_code_valid CHECK (failure_code IS NULL OR failure_code IN (
        'INSUFFICIENT_FUNDS','REVERSAL_WOULD_OVERDRAW','REFERENCE_NOT_FOUND','REFERENCE_NOT_PROCESSED',
        'REFERENCE_MISMATCH','ALREADY_REVERSED','AMOUNT_MISMATCH','CURRENCY_MISMATCH',
        'INVALID_REFERENCE_KIND','INTERNAL_ERROR'))`);
  }

  override down(): void {
    // O índice antigo é mais fraco que o novo, então sempre pode ser recriado.
    this.addSql(`DROP INDEX wt_single_reversal_uq`);
    this.addSql(`
      CREATE UNIQUE INDEX wt_single_reversal_uq
        ON wager_transactions (reference_transaction_id, kind)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);

    // O código novo não existe no CHECK antigo: linhas já gravadas viram REFERENCE_MISMATCH (perda de detalhe).
    this.addSql(
      `UPDATE wager_transactions SET failure_code = 'REFERENCE_MISMATCH' WHERE failure_code = 'REFERENCE_NOT_PROCESSED'`,
    );
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wt_failure_code_valid`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT wt_failure_code_valid CHECK (failure_code IS NULL OR failure_code IN (
        'INSUFFICIENT_FUNDS','REVERSAL_WOULD_OVERDRAW','REFERENCE_NOT_FOUND','REFERENCE_MISMATCH',
        'ALREADY_REVERSED','AMOUNT_MISMATCH','CURRENCY_MISMATCH','INVALID_REFERENCE_KIND','INTERNAL_ERROR'))`);
  }
}
