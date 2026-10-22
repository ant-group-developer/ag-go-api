import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Render batch counters are recounted from the batch's jobs each time one finishes, with the
 * batch row locked so workers on several hosts cannot write a stale count last. Without an
 * index that count scans every render job ever made while holding the lock.
 *
 * Not CONCURRENTLY: this index was small enough that a brief write lock at deploy was
 * acceptable. New indexes on large live tables must use CREATE INDEX CONCURRENTLY with
 * `transaction = false` (see DataRetentionIndexes2150000000000).
 */
export class RenderJobBatchIndexMigration1950000000000 implements MigrationInterface {
  name = 'RenderJobBatchIndexMigration1950000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS media_render_jobs_render_batch_idx
        ON media_render_jobs(render_batch_id)
        WHERE render_batch_id IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS media_render_jobs_render_batch_idx');
  }
}
