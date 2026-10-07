import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Allows the `projects` download scope: one ZIP holding every file of several projects, each in
 * its own folder. Such a job spans projects, so its `project_id` stays NULL unless only one was
 * picked.
 */
export class DownloadProjectsScope2070000000000 implements MigrationInterface {
  name = 'DownloadProjectsScope2070000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE download_jobs DROP CONSTRAINT IF EXISTS download_jobs_scope_check',
    );
    await queryRunner.query(`
      ALTER TABLE download_jobs ADD CONSTRAINT download_jobs_scope_check
      CHECK (scope IN ('single','multiple','project','projects'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM download_jobs WHERE scope = 'projects'`);
    await queryRunner.query(
      'ALTER TABLE download_jobs DROP CONSTRAINT IF EXISTS download_jobs_scope_check',
    );
    await queryRunner.query(`
      ALTER TABLE download_jobs ADD CONSTRAINT download_jobs_scope_check
      CHECK (scope IN ('single','multiple','project'))
    `);
  }
}
