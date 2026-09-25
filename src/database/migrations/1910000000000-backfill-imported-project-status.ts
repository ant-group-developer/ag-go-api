import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Google Drive imports used to refresh media counters without recalculating the evaluation status,
 * leaving projects with imported media in `draft`. Recompute status for those projects.
 */
export class BackfillImportedProjectStatusMigration1910000000000 implements MigrationInterface {
  name = 'BackfillImportedProjectStatusMigration1910000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH counts AS (
        SELECT
          media.project_id,
          COUNT(*)::int AS total,
          (COUNT(*) FILTER (WHERE media.evaluation_status = 'pending'))::int AS pending,
          (COUNT(*) FILTER (WHERE media.evaluation_status = 'approved'))::int AS approved,
          (COUNT(*) FILTER (WHERE media.evaluation_status = 'rejected'))::int AS rejected
        FROM project_media media
        INNER JOIN projects project ON project.id = media.project_id
        WHERE project.evaluation_status = 'draft'
        GROUP BY media.project_id
      ),
      derived AS (
        SELECT
          counts.*,
          CASE
            WHEN pending > 0 THEN 'pending'
            WHEN approved = total THEN 'completed'
            WHEN rejected = total THEN 'failed'
            ELSE 'partially_completed'
          END AS evaluation_status
        FROM counts
      ),
      updated AS (
        UPDATE projects project
        SET evaluation_status = derived.evaluation_status
        FROM derived
        WHERE project.id = derived.project_id
        RETURNING project.id
      )
      INSERT INTO project_evaluation_summaries
        (project_id, total_media, pending_count, approved_count, rejected_count, evaluation_status)
      SELECT project_id, total, pending, approved, rejected, evaluation_status
      FROM derived
      ON CONFLICT (project_id) DO UPDATE SET
        total_media = EXCLUDED.total_media,
        pending_count = EXCLUDED.pending_count,
        approved_count = EXCLUDED.approved_count,
        rejected_count = EXCLUDED.rejected_count,
        evaluation_status = EXCLUDED.evaluation_status,
        calculated_at = now(),
        updated_at = now()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // This data backfill is intentionally not destructive on rollback.
    void queryRunner;
  }
}
