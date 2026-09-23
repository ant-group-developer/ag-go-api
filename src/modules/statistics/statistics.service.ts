import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FolderAccessService } from '../folders/folder-access.service';
import { StatisticsQueryDto } from './dto/statistics-query.dto';

@Injectable()
export class StatisticsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly folderAccess: FolderAccessService,
  ) {}

  async overview(userId: string, userType?: 'ADMIN' | 'USER', query: StatisticsQueryDto = {}) {
    const folderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    if (folderIds.length === 0) {
      return {
        projects: 0,
        assets: 0,
        media: 0,
        originalBytes: '0',
        evaluation: { pending: 0, approved: 0, rejected: 0 },
      };
    }

    const values: unknown[] = [folderIds];
    const dateFilters: string[] = [];
    if (query.from) {
      values.push(query.from);
      dateFilters.push(`p.created_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      dateFilters.push(`p.created_at <= $${values.length}`);
    }
    const row = await this.dataSource.query(
      `WITH scoped_assets AS (
         SELECT DISTINCT a.id, a.file_size_bytes
         FROM projects p2
         INNER JOIN project_media pm2 ON pm2.project_id = p2.id
         INNER JOIN assets a ON a.id = pm2.asset_id
         WHERE p2.folder_id = ANY($1::uuid[])${dateFilters.length ? ` AND ${dateFilters.map((filter) => filter.replaceAll('p.', 'p2.')).join(' AND ')}` : ''}
       )
       SELECT
        COUNT(DISTINCT p.id)::int AS projects,
        COUNT(DISTINCT pm.id)::int AS media,
        COUNT(DISTINCT a.id)::int AS assets,
        COALESCE((SELECT SUM(file_size_bytes) FROM scoped_assets), 0)::text AS "originalBytes",
        COUNT(*) FILTER (WHERE pm.evaluation_status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE pm.evaluation_status = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE pm.evaluation_status = 'rejected')::int AS rejected
       FROM projects p
       LEFT JOIN project_media pm ON pm.project_id = p.id
       LEFT JOIN assets a ON a.id = pm.asset_id
       WHERE p.folder_id = ANY($1::uuid[])${dateFilters.length ? ` AND ${dateFilters.join(' AND ')}` : ''}`,
      values,
    );
    const result = row[0] ?? {};
    return {
      projects: Number(result.projects ?? 0),
      assets: Number(result.assets ?? 0),
      media: Number(result.media ?? 0),
      originalBytes: String(result.originalBytes ?? '0'),
      evaluation: {
        pending: Number(result.pending ?? 0),
        approved: Number(result.approved ?? 0),
        rejected: Number(result.rejected ?? 0),
      },
    };
  }

  async rendering(userId: string, userType?: 'ADMIN' | 'USER', query: StatisticsQueryDto = {}) {
    const folderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    if (folderIds.length === 0) {
      return { queued: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 };
    }
    const values: unknown[] = [folderIds];
    const dateFilters: string[] = [];
    if (query.from) {
      values.push(query.from);
      dateFilters.push(`mrj.created_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      dateFilters.push(`mrj.created_at <= $${values.length}`);
    }
    const row = await this.dataSource.query(
      `SELECT
        COUNT(*) FILTER (WHERE mrj.status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE mrj.status = 'processing')::int AS processing,
        COUNT(*) FILTER (WHERE mrj.status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE mrj.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE mrj.status = 'cancelled')::int AS cancelled,
        COALESCE(AVG(EXTRACT(EPOCH FROM (mrj.finished_at - mrj.started_at)))
          FILTER (WHERE mrj.finished_at IS NOT NULL AND mrj.started_at IS NOT NULL), 0)::float
          AS "averageRenderSeconds"
       FROM media_render_jobs mrj
       INNER JOIN project_media pm ON pm.asset_id = mrj.asset_id
       INNER JOIN projects p ON p.id = pm.project_id
       WHERE p.folder_id = ANY($1::uuid[])${dateFilters.length ? ` AND ${dateFilters.join(' AND ')}` : ''}`,
      values,
    );
    const result = row[0] ?? {};
    return {
      queued: Number(result.queued ?? 0),
      processing: Number(result.processing ?? 0),
      completed: Number(result.completed ?? 0),
      failed: Number(result.failed ?? 0),
      cancelled: Number(result.cancelled ?? 0),
      averageRenderSeconds: Number(result.averageRenderSeconds ?? 0),
    };
  }
}
