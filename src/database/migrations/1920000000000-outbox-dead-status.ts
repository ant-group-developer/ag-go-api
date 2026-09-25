import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An outbox event that keeps failing is parked as `dead` instead of being retried forever; its
 * `last_error` says why, and setting it back to `pending` retries it.
 */
export class OutboxDeadStatusMigration1920000000000 implements MigrationInterface {
  name = 'OutboxDeadStatusMigration1920000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_check
        CHECK (status IN ('pending', 'published', 'failed', 'dead'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE outbox_events SET status = 'failed' WHERE status = 'dead'`);
    await queryRunner.query(`
      ALTER TABLE outbox_events DROP CONSTRAINT IF EXISTS outbox_events_status_check
    `);
    await queryRunner.query(`
      ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_status_check
        CHECK (status IN ('pending', 'published', 'failed'))
    `);
  }
}
