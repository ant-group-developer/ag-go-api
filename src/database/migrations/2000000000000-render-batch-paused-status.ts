import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A render batch can be paused: workers stop claiming its queued jobs and it waits as `paused`
 * until resumed, which queues the jobs still left again.
 */
export class RenderBatchPausedStatusMigration2000000000000 implements MigrationInterface {
  name = 'RenderBatchPausedStatusMigration2000000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE render_batches DROP CONSTRAINT IF EXISTS render_batches_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE render_batches ADD CONSTRAINT render_batches_status_check
        CHECK (status IN ('queued','processing','paused','completed','partial','failed','cancelled'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE render_batches SET status = 'queued' WHERE status = 'paused'`);
    await queryRunner.query(`
      ALTER TABLE render_batches DROP CONSTRAINT IF EXISTS render_batches_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE render_batches ADD CONSTRAINT render_batches_status_check
        CHECK (status IN ('queued','processing','completed','partial','failed','cancelled'))
    `);
  }
}
