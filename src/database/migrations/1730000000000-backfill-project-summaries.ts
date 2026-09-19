import { MigrationInterface, QueryRunner } from 'typeorm';

export class BackfillProjectSummariesMigration1730000000000 implements MigrationInterface {
  name = 'BackfillProjectSummariesMigration1730000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO project_evaluation_summaries (
        project_id,
        total_media,
        pending_count,
        approved_count,
        rejected_count,
        evaluation_status
      )
      SELECT
        p.id,
        p.media_count,
        CASE WHEN p.media_count > 0 THEN p.media_count ELSE 0 END,
        0,
        0,
        p.evaluation_status
      FROM projects p
      WHERE NOT EXISTS (
        SELECT 1
        FROM project_evaluation_summaries summary
        WHERE summary.project_id = p.id
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // This data backfill is intentionally not destructive on rollback.
    void queryRunner;
  }
}
