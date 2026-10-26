import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { UploadSpeedQueryDto } from './dto/upload-speed-query.dto';

/** Completed uploads with their timings, read from the `upload_speed_log` view. */
@Injectable()
export class UploadSpeedService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async list(query: UploadSpeedQueryDto) {
    const values: unknown[] = [];
    const filters = ['TRUE'];
    if (query.from) {
      values.push(query.from);
      filters.push(`u.completed_at >= $${values.length}`);
    }
    if (query.to) {
      values.push(query.to);
      filters.push(`u.completed_at <= $${values.length}`);
    }
    if (query.assetType) {
      values.push(query.assetType);
      filters.push(`u.asset_type = $${values.length}`);
    }
    if (query.mode) {
      values.push(query.mode);
      filters.push(`u.mode = $${values.length}`);
    }
    if (query.projectId) {
      values.push(query.projectId);
      filters.push(`u.project_id = $${values.length}`);
    }
    if (query.folderId) {
      // path_ids runs from the root to the folder itself, so this also matches subfolders.
      values.push(query.folderId);
      filters.push(
        `EXISTS (SELECT 1 FROM folders f WHERE f.id = u.folder_id AND $${values.length}::uuid = ANY(f.path_ids))`,
      );
    }
    if (query.uploaderId) {
      values.push(query.uploaderId);
      filters.push(`u.created_by = $${values.length}`);
    }
    const where = filters.join(' AND ');

    // Speeds cover only uploads the browser timed (watermark logos send no client timings), and
    // the slowest/fastest stretch only uploads made since it was recorded.
    const summaryRows = await this.dataSource.query(
      `SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(u.size_bytes), 0)::bigint AS "totalBytes",
          round(AVG(u.transfer_mbps), 2)::float AS "avgMbps",
          round(percentile_cont(0.5) WITHIN GROUP (ORDER BY u.transfer_mbps)::numeric, 2)::float
            AS "medianMbps",
          MIN(u.min_mbps)::float AS "minMbps",
          MAX(u.max_mbps)::float AS "maxMbps",
          round(AVG(u.transfer_ms))::int AS "avgTransferMs",
          round(AVG(u.total_ms))::int AS "avgTotalMs"
       FROM upload_speed_log u
       WHERE ${where}`,
      values,
    );
    const summary = summaryRows[0] ?? {};
    const total = Number(summary.total ?? 0);

    values.push((query.page - 1) * query.pageSize, query.pageSize);
    const rows = await this.dataSource.query(
      `SELECT
          u.upload_session_id AS "uploadSessionId",
          u.asset_id AS "assetId",
          u.original_filename AS "originalFilename",
          u.asset_type AS "assetType",
          u.size_bytes::bigint AS "sizeBytes",
          u.created_by AS "createdBy",
          u.completed_at AS "completedAt",
          u.project_id AS "projectId",
          u.project_name AS "projectName",
          u.mode,
          u.transfer_ms AS "transferMs",
          u.transfer_mbps::float AS "transferMbps",
          u.min_mbps::float AS "minMbps",
          u.max_mbps::float AS "maxMbps",
          u.idle_ms AS "idleMs",
          u.part_url_wait_ms AS "partUrlWaitMs",
          u.part_count AS "partCount",
          u.parallel_parts AS "parallelParts",
          u.retries,
          u.concurrent_uploads AS "concurrentUploads",
          u.network_type AS "networkType",
          u.downlink_mbps::float AS "downlinkMbps",
          u.rtt_ms AS "rttMs",
          u.assemble_ms AS "assembleMs",
          u.complete_ms AS "completeMs",
          u.total_ms AS "totalMs"
       FROM upload_speed_log u
       WHERE ${where}
       ORDER BY u.completed_at DESC NULLS LAST
       OFFSET $${values.length - 1} LIMIT $${values.length}`,
      values,
    );
    const items = await this.actorEnrichment.enrich(
      rows as Array<Record<string, unknown>>,
      [{ id: 'createdBy', target: 'actorUser' }],
    );
    return {
      items,
      summary: {
        total,
        totalBytes: Number(summary.totalBytes ?? 0),
        avgMbps: summary.avgMbps ?? null,
        medianMbps: summary.medianMbps ?? null,
        minMbps: summary.minMbps ?? null,
        maxMbps: summary.maxMbps ?? null,
        avgTransferMs: summary.avgTransferMs ?? null,
        avgTotalMs: summary.avgTotalMs ?? null,
      },
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /** Projects and uploaders that appear in the log, for the filter dropdowns. */
  async filterOptions() {
    const [projects, uploaders] = await Promise.all([
      this.dataSource.query(
        `SELECT DISTINCT u.project_id AS id, u.project_name AS name
         FROM upload_speed_log u
         WHERE u.project_id IS NOT NULL
         ORDER BY u.project_name`,
      ),
      this.dataSource.query(
        `SELECT DISTINCT u.created_by AS id
         FROM upload_speed_log u
         WHERE u.created_by IS NOT NULL`,
      ),
    ]);
    const enriched = await this.actorEnrichment.enrich(
      uploaders as Array<Record<string, unknown>>,
      [{ id: 'id', target: 'user' }],
    );
    return {
      projects: projects as Array<{ id: string; name: string | null }>,
      uploaders: enriched.map((row) => {
        const user = row.user as { name?: unknown; email?: unknown } | undefined;
        return {
          id: row.id as string,
          name: typeof user?.name === 'string' ? user.name : null,
          email: typeof user?.email === 'string' ? user.email : null,
        };
      }),
    };
  }
}
