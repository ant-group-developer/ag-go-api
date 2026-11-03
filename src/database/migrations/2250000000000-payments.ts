import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payments, ANTGO-254 (spec "dac-ta-hop-dong-nghiem-thu" 6.6, 7.8, BR-30…35).
 *
 * `payments`: advances paid under a contract, payments of issued acceptance records (one or more
 * per record) and advances returned by the partner. Never deleted: a wrong payment is cancelled with
 * a reason. The transfer proof is stored in R2 next to the contract documents. The advance balance
 * of a contract is the advances actually paid (plus the balance carried by an imported contract)
 * minus refunds and the offsets of its acceptance records.
 */
export class Payments2250000000000 implements MigrationInterface {
  name = 'Payments2250000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE payments (
        id uuid PRIMARY KEY,
        contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
        partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        acceptance_id uuid NULL REFERENCES acceptance_records(id) ON DELETE RESTRICT,
        kind varchar(20) NOT NULL CHECK (kind IN ('advance', 'settlement', 'refund')),
        amount bigint NOT NULL CHECK (amount > 0),
        paid_date date NOT NULL,
        method varchar(20) NOT NULL DEFAULT 'bank_transfer'
          CHECK (method IN ('bank_transfer', 'cash', 'other')),
        reference varchar(200) NULL,
        note text NULL,
        status varchar(20) NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'cancelled')),
        proof_storage_key text NULL,
        proof_file_name varchar(255) NULL,
        proof_content_type varchar(120) NULL,
        proof_size_bytes bigint NULL CHECK (proof_size_bytes IS NULL OR proof_size_bytes >= 0),
        proof_checksum_sha256 varchar(64) NULL,
        proof_uploaded_at timestamptz NULL,
        proof_uploaded_by varchar(128) NULL,
        cancelled_reason text NULL,
        cancelled_at timestamptz NULL,
        cancelled_by varchar(128) NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT payments_acceptance_check
          CHECK ((kind = 'settlement') = (acceptance_id IS NOT NULL)),
        CONSTRAINT payments_cancel_reason_check
          CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX payments_contract_idx ON payments(contract_id, paid_date DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX payments_acceptance_idx ON payments(acceptance_id)
       WHERE acceptance_id IS NOT NULL AND status = 'recorded'`,
    );
    await queryRunner.query(`CREATE INDEX payments_paid_date_idx ON payments(paid_date)`);
    await queryRunner.query(
      `CREATE INDEX acceptance_records_due_idx ON acceptance_records(due_date)
       WHERE status IN ('signed', 'partially_paid')`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS acceptance_records_due_idx`);
    // Records paid through AG Go go back to `signed` (the payment statuses came with this table).
    await queryRunner.query(
      `UPDATE acceptance_records SET status = 'signed' WHERE status IN ('partially_paid', 'paid')`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS payments`);
  }
}
