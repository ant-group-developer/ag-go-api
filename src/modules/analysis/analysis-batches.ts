import type { EntityManager } from 'typeorm';
import { AnalysisBatchEntity } from '../../database/entities/analysis-batch.entity';

/** Name of the single automatic batch (uploads, re-renders, manual re-runs). */
export const AUTO_BATCH_NAME = 'Tự động';

/** Farm `group_key` of a batch: pausing / resuming / cancelling the group acts on all its jobs. */
export function batchGroupKey(batchId: string): string {
  return `batch:${batchId}`;
}

/**
 * Id of the automatic batch, created on first use. A unique partial index on `kind = 'auto'`
 * keeps two concurrent callers from creating two.
 */
export async function autoBatchId(manager: EntityManager): Promise<string> {
  const existing = await manager.findOne(AnalysisBatchEntity, { where: { kind: 'auto' } });
  if (existing) return existing.id;
  await manager
    .createQueryBuilder()
    .insert()
    .into(AnalysisBatchEntity)
    .values({
      name: AUTO_BATCH_NAME,
      kind: 'auto',
      mode: null,
      scope: {},
      priority: 0,
      status: 'running',
    })
    .orIgnore()
    .execute();
  const created = await manager.findOneOrFail(AnalysisBatchEntity, { where: { kind: 'auto' } });
  return created.id;
}
