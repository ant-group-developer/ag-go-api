import type { EntityManager } from 'typeorm';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';

/** Progress message of a job cancelled because a newer render of the same file was requested. */
export const SUPERSEDED_JOB_MESSAGE = 'Cancelled: superseded by a newer render of this file';

/**
 * Cancels the queued and running render jobs of `assetIds`, except `keepJobIds`, so only the
 * newest render of a file (for example with a new profile) produces its previews. Workers skip
 * cancelled queued jobs and stop running ones (see MediaProcessingService). Returns the ids of
 * the cancelled jobs.
 */
export async function cancelSupersededRenderJobs(
  manager: EntityManager,
  assetIds: string[],
  keepJobIds: string[],
): Promise<string[]> {
  if (assetIds.length === 0) {
    return [];
  }
  const query = manager
    .createQueryBuilder()
    .update(MediaRenderJobEntity)
    .set({
      status: 'cancelled',
      progressMessage: SUPERSEDED_JOB_MESSAGE,
      finishedAt: () => 'NOW()',
    })
    .where('asset_id IN (:...assetIds)', { assetIds: [...new Set(assetIds)] })
    .andWhere('status IN (:...statuses)', { statuses: ['queued', 'processing'] });
  if (keepJobIds.length > 0) {
    query.andWhere('id NOT IN (:...keepJobIds)', { keepJobIds });
  }
  const result = await query.returning(['id', 'renderBatchId']).execute();
  const rows = result.raw as Array<{ id: string; render_batch_id: string | null }>;
  for (const batchId of new Set(rows.map((row) => row.render_batch_id))) {
    await refreshRenderBatch(manager, batchId);
  }
  return rows.map((row) => row.id);
}

/** Recomputes a render batch's counters and status from its jobs. */
export async function refreshRenderBatch(
  manager: EntityManager,
  batchId: string | null,
): Promise<void> {
  if (!batchId) {
    return;
  }
  const jobs = await manager.find(MediaRenderJobEntity, {
    select: { id: true, status: true },
    where: { renderBatchId: batchId },
  });
  if (jobs.length === 0) {
    return;
  }
  const completed = jobs.filter((item) => item.status === 'completed').length;
  const failed = jobs.filter((item) => item.status === 'failed').length;
  const cancelled = jobs.filter((item) => item.status === 'cancelled').length;
  const terminal = completed + failed + cancelled;
  const status =
    terminal < jobs.length
      ? 'processing'
      : cancelled === jobs.length
        ? 'cancelled'
        : failed > 0 || cancelled > 0
          ? completed > 0
            ? 'partial'
            : 'failed'
          : 'completed';
  await manager.update(RenderBatchEntity, batchId, {
    status,
    totalJobs: jobs.length,
    completedJobs: completed,
    failedJobs: failed,
    progressPercent: Math.round((terminal / jobs.length) * 100),
  });
}

/** True when `assetId` has a render job created after `job` (the older one must not be retried). */
export async function hasNewerRenderJob(
  manager: EntityManager,
  job: Pick<MediaRenderJobEntity, 'id' | 'assetId' | 'createdAt'>,
): Promise<boolean> {
  return manager
    .createQueryBuilder(MediaRenderJobEntity, 'job')
    .where('job.asset_id = :assetId', { assetId: job.assetId })
    .andWhere('job.id <> :id', { id: job.id })
    .andWhere('job.created_at > :createdAt', { createdAt: job.createdAt })
    .andWhere('job.status <> :cancelled', { cancelled: 'cancelled' })
    .getExists();
}
