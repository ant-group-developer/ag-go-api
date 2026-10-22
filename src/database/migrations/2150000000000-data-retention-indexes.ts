import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retention jobs filter outbox rows by status and published/updated time, and studio usage by
 * occurred_at. Those tables grow without bound until purged, so the builds must not lock writes
 * (the lesson from StudioUsage2130000000000 indexing download_logs in a transaction).
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction.
 */
export class DataRetentionIndexes2150000000000 implements MigrationInterface {
  name = 'DataRetentionIndexes2150000000000';
  transaction = false;

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_retention_published_idx
      ON outbox_events(status, published_at)
      WHERE status = 'published'
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_retention_dead_idx
      ON outbox_events(status, updated_at)
      WHERE status = 'dead'
    `);
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS studio_usage_events_occurred_idx
      ON studio_usage_events(occurred_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS studio_usage_events_occurred_idx`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS outbox_events_retention_dead_idx`);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS outbox_events_retention_published_idx`,
    );
  }
}
