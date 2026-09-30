import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsPeriodQueryDto } from './dto/statistics-period-query.dto';
import { evaluationTransitionsCte } from './sql/evaluation-transitions.sql';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { resolveStatisticsPeriod, toPeriodInfo } from './statistics-period';
import { StatisticsScopeService } from './statistics-scope.service';
import type { StatisticsPeriodInfo, StatisticsSummary } from './statistics.types';

/**
 * $4 from, $5 effectiveTo (current window [$4, $5)), $6 previousFrom, $7 previousTo (previous
 * window [$6, $7)). Snapshot columns ignore the window. Images and videos come from the project
 * counters (recomputed whenever a project's media change), which saves joining every asset.
 */
const SUMMARY_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
${evaluationTransitionsCte('$6', '$5')},
project_stats AS (
  SELECT
    COUNT(*)::int AS total,
    COALESCE(SUM(p.image_count), 0)::int AS images,
    COALESCE(SUM(p.video_count), 0)::int AS videos,
    COUNT(*) FILTER (WHERE sp.evaluation_status = 'draft')::int AS draft,
    COUNT(*) FILTER (WHERE sp.evaluation_status = 'pending')::int AS pending,
    COUNT(*) FILTER (WHERE sp.evaluation_status = 'completed')::int AS completed,
    COUNT(*) FILTER (WHERE sp.evaluation_status = 'partially_completed')::int AS partially_completed,
    COUNT(*) FILTER (WHERE sp.evaluation_status = 'failed')::int AS failed,
    COUNT(*) FILTER (WHERE sp.created_at >= $4::timestamptz AND sp.created_at < $5::timestamptz)::int AS new_current,
    COUNT(*) FILTER (WHERE sp.created_at >= $6::timestamptz AND sp.created_at < $7::timestamptz)::int AS new_previous
  FROM scoped_projects sp
  INNER JOIN projects p ON p.id = sp.id
),
media_stats AS (
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE pm.evaluation_status = 'pending')::int AS pending,
    COUNT(*) FILTER (WHERE pm.evaluation_status = 'approved')::int AS approved,
    COUNT(*) FILTER (WHERE pm.evaluation_status = 'rejected')::int AS rejected,
    MIN(pm.created_at) FILTER (WHERE pm.evaluation_status = 'pending') AS oldest_pending_at,
    COUNT(*) FILTER (WHERE pm.created_at >= $4::timestamptz AND pm.created_at < $5::timestamptz)::int AS new_current,
    COUNT(*) FILTER (WHERE pm.created_at >= $6::timestamptz AND pm.created_at < $7::timestamptz)::int AS new_previous
  FROM project_media pm
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
),
decision_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE new_status = 'approved' AND created_at >= $4::timestamptz)::int AS approved_current,
    COUNT(*) FILTER (WHERE new_status = 'rejected' AND created_at >= $4::timestamptz)::int AS rejected_current,
    COUNT(*) FILTER (WHERE new_status = 'approved' AND created_at < $7::timestamptz)::int AS approved_previous,
    COUNT(*) FILTER (WHERE new_status = 'rejected' AND created_at < $7::timestamptz)::int AS rejected_previous
  FROM transitions
)
SELECT
  row_to_json(ps) AS projects,
  row_to_json(ms) AS media,
  row_to_json(ds) AS decisions
FROM project_stats ps, media_stats ms, decision_stats ds`;

/**
 * Storage counts every asset once even when several projects share it, so it cannot use the
 * project counters. It is the heaviest part and runs as its own query, next to SUMMARY_SQL.
 */
const STORAGE_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
scoped_assets AS (
  SELECT DISTINCT pm.asset_id
  FROM project_media pm
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
),
storage_stats AS (
  SELECT
    COALESCE((
      SELECT SUM(a.file_size_bytes) FROM assets a INNER JOIN scoped_assets s ON s.asset_id = a.id
    ), 0)::text AS original_bytes,
    COALESCE((
      SELECT SUM(v.file_size_bytes)
      FROM asset_variants v
      INNER JOIN scoped_assets s ON s.asset_id = v.asset_id
      WHERE v.status = 'ready'
    ), 0)::text AS rendered_bytes
)
SELECT original_bytes, rendered_bytes FROM storage_stats`;

type SummaryRow = {
  projects: Record<string, number>;
  media: Record<string, number> & { oldest_pending_at: string | null };
  decisions: Record<string, number>;
};

type StorageRow = { original_bytes: string; rendered_bytes: string };

@Injectable()
export class StatisticsSummaryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
  ) {}

  async summary(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsPeriodQueryDto,
  ): Promise<StatisticsSummary> {
    const period = resolveStatisticsPeriod(query);
    const periodInfo = toPeriodInfo(period);
    const scope = await this.scopeService.resolve(context);
    if (scope.empty) {
      return emptySummary(periodInfo);
    }

    const [rows, storageRows] = (await Promise.all([
      this.dataSource.query(SUMMARY_SQL, [
        ...scopeValues(scope),
        period.from,
        period.effectiveTo,
        period.previousFrom,
        period.previousTo,
      ]),
      this.dataSource.query(STORAGE_SQL, scopeValues(scope)),
    ])) as [SummaryRow[], StorageRow[]];
    const row = rows[0];
    if (!row) {
      return emptySummary(periodInfo);
    }
    const { projects, media, decisions } = row;
    const storage = storageRows[0] ?? { original_bytes: '0', rendered_bytes: '0' };
    return {
      period: periodInfo,
      snapshot: {
        projects: Number(projects.total ?? 0),
        projectsByStatus: {
          draft: Number(projects.draft ?? 0),
          pending: Number(projects.pending ?? 0),
          completed: Number(projects.completed ?? 0),
          partially_completed: Number(projects.partially_completed ?? 0),
          failed: Number(projects.failed ?? 0),
        },
        media: {
          total: Number(media.total ?? 0),
          images: Number(projects.images ?? 0),
          videos: Number(projects.videos ?? 0),
        },
        evaluation: {
          pending: Number(media.pending ?? 0),
          approved: Number(media.approved ?? 0),
          rejected: Number(media.rejected ?? 0),
          oldestPendingAt: toIsoOrNull(media.oldest_pending_at),
        },
        storage: {
          originalBytes: String(storage.original_bytes ?? '0'),
          renderedBytes: String(storage.rendered_bytes ?? '0'),
        },
      },
      inPeriod: {
        newProjects: periodCount(projects.new_current, projects.new_previous),
        newMedia: periodCount(media.new_current, media.new_previous),
        decisions: {
          approved: periodCount(decisions.approved_current, decisions.approved_previous),
          rejected: periodCount(decisions.rejected_current, decisions.rejected_previous),
        },
      },
    };
  }
}

function periodCount(current: unknown, previous: unknown) {
  return { current: Number(current ?? 0), previous: Number(previous ?? 0) };
}

function toIsoOrNull(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function emptySummary(period: StatisticsPeriodInfo): StatisticsSummary {
  const zero = { current: 0, previous: 0 };
  return {
    period,
    snapshot: {
      projects: 0,
      projectsByStatus: { draft: 0, pending: 0, completed: 0, partially_completed: 0, failed: 0 },
      media: { total: 0, images: 0, videos: 0 },
      evaluation: { pending: 0, approved: 0, rejected: 0, oldestPendingAt: null },
      storage: { originalBytes: '0', renderedBytes: '0' },
    },
    inPeriod: {
      newProjects: zero,
      newMedia: zero,
      decisions: { approved: zero, rejected: zero },
    },
  };
}
