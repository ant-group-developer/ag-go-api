import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Deleting a project used to keep assets stored outside its prefix even when no project used
 * them anymore (see ProjectsService.remove), and their render jobs kept running. Those jobs are
 * cancelled here; the assets themselves are left in place. Only assets stored under a project
 * that no longer exists and used by no project count, so an upload still being attached is
 * left alone.
 *
 * Then every unfinished batch is recounted: job deletes never refreshed them, so batches of
 * deleted projects stayed `processing` with counters that never moved.
 */
export class StopOrphanRenderJobsMigration1960000000000 implements MigrationInterface {
  name = 'StopOrphanRenderJobsMigration1960000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // A worker rendering one of them stops at its next cancel check (status is no longer
    // `processing`), and a queued one is skipped when claimed.
    await queryRunner.query(`
      UPDATE media_render_jobs job
      SET status = 'cancelled',
          claim_token = NULL,
          progress_message = 'Cancelled: project deleted',
          finished_at = now(),
          updated_at = now()
      FROM assets asset
      WHERE asset.id = job.asset_id
        AND job.status IN ('queued', 'processing')
        AND asset.original_storage_key LIKE 'projects/%'
        AND NOT EXISTS (
          SELECT 1 FROM projects project
          WHERE project.id::text = split_part(asset.original_storage_key, '/', 2)
        )
        AND NOT EXISTS (SELECT 1 FROM project_media media WHERE media.asset_id = asset.id)
    `);

    // Same rules as recountRenderBatch; a batch with no job left has nothing to render.
    await queryRunner.query(`
      UPDATE render_batches batch
      SET total_jobs = counts.total,
          completed_jobs = counts.completed,
          failed_jobs = counts.failed,
          progress_percent = CASE
            WHEN counts.total = 0 THEN 100
            ELSE ROUND(counts.terminal * 100.0 / counts.total)
          END,
          status = CASE
            WHEN counts.total = 0 THEN 'cancelled'
            WHEN counts.terminal < counts.total THEN 'processing'
            WHEN counts.cancelled = counts.total THEN 'cancelled'
            WHEN counts.failed > 0 OR counts.cancelled > 0 THEN
              CASE WHEN counts.completed > 0 THEN 'partial' ELSE 'failed' END
            ELSE 'completed'
          END,
          updated_at = now()
      FROM (
        SELECT b.id,
          COUNT(job.id)::int AS total,
          COUNT(job.id) FILTER (WHERE job.status = 'completed')::int AS completed,
          COUNT(job.id) FILTER (WHERE job.status = 'failed')::int AS failed,
          COUNT(job.id) FILTER (WHERE job.status = 'cancelled')::int AS cancelled,
          COUNT(job.id) FILTER (
            WHERE job.status IN ('completed', 'failed', 'cancelled')
          )::int AS terminal
        FROM render_batches b
        LEFT JOIN media_render_jobs job ON job.render_batch_id = b.id
        WHERE b.status IN ('queued', 'processing')
        GROUP BY b.id
      ) counts
      WHERE batch.id = counts.id
    `);
  }

  async down(): Promise<void> {
    // Cancelled jobs are not resumed; render the files again if needed.
  }
}
