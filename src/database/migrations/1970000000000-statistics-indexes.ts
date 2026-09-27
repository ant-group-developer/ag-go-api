import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The statistics page filters evaluations, newly added media and finished render jobs by date and
 * lists the latest audit entries across every project. Without these indexes each of those reads
 * scans the whole table.
 *
 * Not CONCURRENTLY: migrations run in one transaction (deploy.sh). The builds block writes to
 * these tables only briefly, at the main host's deploy.
 */
export class StatisticsIndexesMigration1970000000000 implements MigrationInterface {
  name = 'StatisticsIndexesMigration1970000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS project_media_evaluations_created_idx
        ON project_media_evaluations(created_at)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS project_media_created_idx
        ON project_media(created_at)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS project_audit_logs_created_idx
        ON project_audit_logs(created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS media_render_jobs_finished_idx
        ON media_render_jobs(finished_at)
        WHERE finished_at IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS media_render_jobs_finished_idx');
    await queryRunner.query('DROP INDEX IF EXISTS project_audit_logs_created_idx');
    await queryRunner.query('DROP INDEX IF EXISTS project_media_created_idx');
    await queryRunner.query('DROP INDEX IF EXISTS project_media_evaluations_created_idx');
  }
}
