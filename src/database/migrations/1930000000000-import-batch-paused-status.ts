import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A Google Drive import can be paused: the worker stops claiming its files and it waits as
 * `paused` until resumed, which queues it again from the files still left.
 */
export class ImportBatchPausedStatusMigration1930000000000 implements MigrationInterface {
  name = 'ImportBatchPausedStatusMigration1930000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE import_batches ADD CONSTRAINT import_batches_status_check
        CHECK (status IN ('queued','processing','paused','completed','partial','failed','cancelled'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE import_batches SET status = 'queued' WHERE status = 'paused'`);
    await queryRunner.query(`
      ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE import_batches ADD CONSTRAINT import_batches_status_check
        CHECK (status IN ('queued','processing','completed','partial','failed','cancelled'))
    `);
  }
}
