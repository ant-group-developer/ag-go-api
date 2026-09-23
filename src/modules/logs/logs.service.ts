import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { LogsQueryDto } from './dto/logs-query.dto';

@Injectable()
export class LogsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly folderAccess: FolderAccessService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async list(query: LogsQueryDto, userId: string, userType?: 'ADMIN' | 'USER') {
    const folderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    if (!folderIds.length) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 };
    }
    const values: unknown[] = [folderIds];
    const filters = [`(a.project_id IS NULL OR p.folder_id = ANY($1::uuid[]))`];
    if (query.category) {
      values.push(query.category);
      filters.push(`a.category = $${values.length}`);
    }
    if (query.action) {
      values.push(query.action);
      filters.push(`a.action = $${values.length}`);
    }
    if (query.level) {
      values.push(query.level);
      filters.push(`a.level = $${values.length}`);
    }
    if (query.from) {
      values.push(query.from);
      filters.push(`a.created_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      filters.push(`a.created_at <= $${values.length}`);
    }
    const where = filters.join(' AND ');
    const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
       FROM (
         SELECT pal.id::text, 'audit' AS category, pal.action, pal.actor_user_id AS user_id,
                pal.project_id, pal.created_at
         FROM project_audit_logs pal
         UNION ALL
         SELECT sl.id::text, sl.category, sl.action, sl.user_id, sl.project_id, sl.created_at
         FROM system_logs sl
       ) a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE ${where}`,
      values,
    );
    const total = Number(countRows[0]?.total ?? 0);
    values.push((query.page - 1) * query.pageSize, query.pageSize);
    const rows = await this.dataSource.query(
      `SELECT
          a.id,
          a.category,
          a.level,
          a.action,
          a.message,
          a.user_id AS "userId",
          a.project_id AS "projectId",
          a.created_at AS "createdAt",
          a.metadata
       FROM (
         SELECT pal.id::text AS id, 'audit' AS category, 'info' AS level, pal.action,
                pal.action AS message, pal.actor_user_id AS user_id, pal.project_id,
                pal.created_at, pal.metadata
         FROM project_audit_logs pal
         UNION ALL
         SELECT sl.id::text, sl.category, sl.level, sl.action, sl.message, sl.user_id,
                sl.project_id, sl.created_at, sl.metadata
         FROM system_logs sl
       ) a
       LEFT JOIN projects p ON p.id = a.project_id
       WHERE ${where}
       ORDER BY a.created_at DESC
       OFFSET $${values.length - 1} LIMIT $${values.length}`,
      values,
    );
    const items = await this.actorEnrichment.enrich(
      rows as Array<Record<string, unknown>>,
      [{ id: 'userId', target: 'actorUser' }],
    );
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}
