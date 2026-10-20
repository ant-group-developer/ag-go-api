import { MigrationInterface, QueryRunner } from 'typeorm';

export class DataRetentionIndexes2150000000000 implements MigrationInterface {
  name = 'DataRetentionIndexes2150000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS outbox_events_retention_published_idx
      ON outbox_events(status, published_at)
      WHERE status = 'published'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS outbox_events_retention_dead_idx
      ON outbox_events(status, updated_at)
      WHERE status = 'dead'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS studio_usage_events_occurred_idx
      ON studio_usage_events(occurred_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS studio_usage_events_occurred_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS outbox_events_retention_dead_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS outbox_events_retention_published_idx`);
  }
}
