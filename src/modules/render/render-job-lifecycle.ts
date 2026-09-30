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
    // Each list is one array parameter: a batch can cover more files than the 65535 bind
    // parameters Postgres takes per statement.
    .where('asset_id = ANY(:assetIds)', { assetIds: [...new Set(assetIds)] })
    .andWhere('status IN (:...statuses)', { statuses: ['queued', 'processing'] });
  if (keepJobIds.length > 0) {
    query.andWhere('NOT (id = ANY(:keepJobIds))', { keepJobIds });
  }
  const result = await query.returning(['id', 'renderBatchId']).execute();
  const rows = result.raw as Array<{ id: string; render_batch_id: string | null }>;
  // In a fixed order: each refresh locks its batch row until the caller's transaction ends,
  // and two transactions locking the same batches in opposite orders would deadlock.
  for (const batchId of [...new Set(rows.map((row) => row.render_batch_id))].sort()) {
    await refreshRenderBatch(manager, batchId);
  }
  return rows.map((row) => row.id);
}

/**
 * Recomputes a render batch's counters and status from its jobs. Workers, on one host or
 * several, finish jobs of the same batch at the same time: counted without a lock, an older
 * count could be written last and leave the batch short of done for good (546/547, still
 * processing), since nothing recounts it afterwards. The batch row is locked first, so the
 * refreshes run one after another and each counts every job committed before it.
 */
export async function refreshRenderBatch(
  manager: EntityManager,
  batchId: string | null,
): Promise<void> {
  if (!batchId) {
    return;
  }
  // Inside a caller's transaction this becomes a savepoint, and the lock lasts until it ends.
  await manager.transaction((transaction) => recountRenderBatch(transaction, batchId));
}

async function recountRenderBatch(manager: EntityManager, batchId: string): Promise<void> {
  const locked = await manager
    .createQueryBuilder(RenderBatchEntity, 'batch')
    .select(['batch.id', 'batch.status'])
    .setLock('pessimistic_write')
    .where('batch.id = :batchId', { batchId })
    .getOne();
  if (!locked) {
    return;
  }
  // A new statement after the lock: under READ COMMITTED it sees every job committed so far.
  // One indexed aggregate, since the lock is held while it runs.
  const counts = await manager
    .createQueryBuilder(MediaRenderJobEntity, 'job')
    .select('COUNT(*)::int', 'total')
    .addSelect("COUNT(*) FILTER (WHERE job.status = 'completed')::int", 'completed')
    .addSelect("COUNT(*) FILTER (WHERE job.status = 'failed')::int", 'failed')
    .addSelect("COUNT(*) FILTER (WHERE job.status = 'cancelled')::int", 'cancelled')
    .where('job.render_batch_id = :batchId', { batchId })
    .getRawOne<{ total: number; completed: number; failed: number; cancelled: number }>();
  const { total = 0, completed = 0, failed = 0, cancelled = 0 } = counts ?? {};
  if (total === 0) {
    // Every job went with its asset (the project was deleted): nothing is left to render.
    await manager.update(RenderBatchEntity, batchId, {
      status: 'cancelled',
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      progressPercent: 100,
    });
    return;
  }
  const terminal = completed + failed + cancelled;
  // A cancelled batch stays cancelled, and a paused one stays paused while jobs are left for
  // its resume: the jobs that were already running when it was cancelled or paused still
  // finish and are counted here.
  const status =
    locked.status === 'cancelled'
      ? 'cancelled'
      : terminal < total
        ? locked.status === 'paused'
          ? 'paused'
          : 'processing'
        : cancelled === total
          ? 'cancelled'
          : failed > 0 || cancelled > 0
            ? completed > 0
              ? 'partial'
              : 'failed'
            : 'completed';
  await manager.update(RenderBatchEntity, batchId, {
    status,
    totalJobs: total,
    completedJobs: completed,
    failedJobs: failed,
    progressPercent: Math.round((terminal / total) * 100),
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
