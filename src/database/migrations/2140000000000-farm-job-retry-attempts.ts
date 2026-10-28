import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `attempt_count` to `analysis_farm_jobs` and `asset_prep_farm_jobs` so poison jobs
 * (results that repeatedly crash or fail during ingestion) can be bounded by max attempts,
 * marked failed and acknowledged instead of blocking the poll indefinitely.
 */
export class FarmJobRetryAttempts2140000000000 implements MigrationInterface {
  name = 'FarmJobRetryAttempts2140000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE analysis_farm_jobs
        ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
    `);
    await queryRunner.query(`
      ALTER TABLE asset_prep_farm_jobs
        ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE asset_prep_farm_jobs DROP COLUMN IF EXISTS attempt_count`);
    await queryRunner.query(`ALTER TABLE analysis_farm_jobs DROP COLUMN IF EXISTS attempt_count`);
  }
}
