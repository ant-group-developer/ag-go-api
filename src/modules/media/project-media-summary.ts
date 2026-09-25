import type { EntityManager } from 'typeorm';
import { AssetEntity } from '../../database/entities/asset.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { deriveProjectEvaluationStatus } from './evaluation-status';

/**
 * Recalculates a project's media counters and evaluation status after media is added or replaced,
 * so a project leaves `draft` as soon as it has media (local upload or Google Drive import).
 */
export async function refreshProjectMediaSummary(
  manager: EntityManager,
  projectId: string,
): Promise<void> {
  const aggregate = await manager
    .createQueryBuilder(ProjectMediaEntity, 'media')
    .innerJoin(AssetEntity, 'asset', 'asset.id = media.asset_id')
    .select('COUNT(*)', 'totalMedia')
    .addSelect("COUNT(*) FILTER (WHERE asset.asset_type = 'image')", 'imageCount')
    .addSelect("COUNT(*) FILTER (WHERE asset.asset_type = 'video')", 'videoCount')
    .addSelect('COALESCE(SUM(asset.file_size_bytes), 0)', 'originalBytes')
    .where('media.project_id = :projectId', { projectId })
    .getRawOne<{
      totalMedia: string;
      imageCount: string;
      videoCount: string;
      originalBytes: string;
    }>();
  const totalMedia = Number(aggregate?.totalMedia ?? 0);
  await manager.update(ProjectEntity, projectId, {
    mediaCount: totalMedia,
    imageCount: Number(aggregate?.imageCount ?? 0),
    videoCount: Number(aggregate?.videoCount ?? 0),
    originalBytes: String(aggregate?.originalBytes ?? 0),
  });
  const counts = await manager
    .createQueryBuilder(ProjectMediaEntity, 'media')
    .select('COUNT(*)', 'total')
    .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'pending')", 'pending')
    .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'approved')", 'approved')
    .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'rejected')", 'rejected')
    .where('media.project_id = :projectId', { projectId })
    .getRawOne<{ total: string; pending: string; approved: string; rejected: string }>();
  const pending = Number(counts?.pending ?? 0);
  const approved = Number(counts?.approved ?? 0);
  const rejected = Number(counts?.rejected ?? 0);
  const evaluationStatus = deriveProjectEvaluationStatus(totalMedia, pending, approved, rejected);
  await manager.update(ProjectEntity, projectId, { evaluationStatus });
  await manager.query(
    `INSERT INTO project_evaluation_summaries
      (project_id, total_media, pending_count, approved_count, rejected_count, evaluation_status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id) DO UPDATE SET
      total_media = EXCLUDED.total_media,
      pending_count = EXCLUDED.pending_count,
      approved_count = EXCLUDED.approved_count,
      rejected_count = EXCLUDED.rejected_count,
      evaluation_status = EXCLUDED.evaluation_status,
      calculated_at = now(),
      updated_at = now()`,
    [projectId, totalMedia, pending, approved, rejected, evaluationStatus],
  );
}
