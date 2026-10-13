import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsPeriodQueryDto } from './dto/statistics-period-query.dto';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { resolveStatisticsPeriod } from './statistics-period';
import { StatisticsScopeService } from './statistics-scope.service';

/** Rows of the top footage and top project lists. */
const TOP_LIMIT = 20;

/**
 * Footage use in AG Studio and downloads inside the window, for footage of the caller's projects.
 * `$1..$3` scope (SCOPED_PROJECTS_CTE), `$4` from, `$5` effectiveTo.
 * - uses: Studio events (not `source_removed`) of footage in scope, or of a project in scope added
 *   to Studio as a whole;
 * - downloads: one row per downloaded footage file: direct downloads (single files, files of a
 *   zip) and the footage files of Premiere exports.
 */
const USAGE_CTES = `${SCOPED_PROJECTS_CTE},
scoped_assets AS (
  SELECT DISTINCT pm.asset_id FROM project_media pm JOIN scoped_projects sp ON sp.id = pm.project_id
),
uses AS (
  SELECT e.kind, e.asset_id, e.ag_go_project_id, e.studio_project_id, e.studio_video_id,
         COALESCE(e.studio_job_id, e.event_key) AS job, e.occurred_at
  FROM studio_usage_events e
  WHERE e.kind <> 'source_removed'
    AND e.occurred_at >= $4::timestamptz AND e.occurred_at < $5::timestamptz
    AND (e.asset_id IN (SELECT asset_id FROM scoped_assets)
      OR (e.asset_id IS NULL AND e.ag_go_project_id IN (SELECT id FROM scoped_projects)))
),
downloads AS (
  SELECT dl.asset_id, dl.created_at AS at
  FROM download_logs dl
  WHERE dl.status = 'started' AND dl.asset_id IN (SELECT asset_id FROM scoped_assets)
    AND dl.created_at >= $4::timestamptz AND dl.created_at < $5::timestamptz
  UNION ALL
  SELECT di.asset_id, di.created_at
  FROM download_job_items di
  WHERE di.status <> 'failed' AND di.asset_id IN (SELECT asset_id FROM scoped_assets)
    AND di.created_at >= $4::timestamptz AND di.created_at < $5::timestamptz
  UNION ALL
  SELECT u.asset_id, u.occurred_at FROM uses u WHERE u.kind = 'premiere_export' AND u.asset_id IS NOT NULL
)`;

const TOTALS_SQL = `
WITH ${USAGE_CTES}
SELECT
  (SELECT COUNT(DISTINCT studio_project_id) FROM uses)::int AS projects,
  (SELECT COUNT(DISTINCT studio_video_id) FROM uses
    WHERE kind IN ('final_render','premiere_export') AND studio_video_id IS NOT NULL)::int AS videos,
  (SELECT COUNT(DISTINCT job) FROM uses WHERE kind = 'final_render')::int AS "finalRenders",
  (SELECT COUNT(DISTINCT job) FROM uses WHERE kind = 'premiere_export')::int AS "premiereExports",
  (SELECT COUNT(*) FROM downloads)::int AS downloads,
  (SELECT COUNT(DISTINCT asset_id) FROM uses WHERE asset_id IS NOT NULL)::int AS "assetsUsed"`;

const TOP_ASSETS_SQL = `
WITH ${USAGE_CTES},
per_asset AS (
  SELECT a.asset_id,
         (SELECT COUNT(DISTINCT u.studio_video_id) FROM uses u
           WHERE u.asset_id = a.asset_id AND u.kind IN ('final_render','premiere_export')) AS videos,
         (SELECT COUNT(*) FROM downloads d WHERE d.asset_id = a.asset_id) AS downloads
  FROM (SELECT asset_id FROM uses WHERE asset_id IS NOT NULL
        UNION SELECT asset_id FROM downloads) a
)
SELECT p.asset_id AS "assetId", asst.original_filename AS name,
       p.videos::int AS videos, p.downloads::int AS downloads
FROM per_asset p
JOIN assets asst ON asst.id = p.asset_id
WHERE p.videos > 0 OR p.downloads > 0
ORDER BY p.videos DESC, p.downloads DESC, asst.original_filename ASC
LIMIT ${TOP_LIMIT}`;

const TOP_PROJECTS_SQL = `
WITH ${USAGE_CTES},
project_uses AS (
  SELECT pm.project_id, u.*
  FROM uses u JOIN project_media pm ON pm.asset_id = u.asset_id
  WHERE pm.project_id IN (SELECT id FROM scoped_projects)
  UNION ALL
  SELECT u.ag_go_project_id, u.* FROM uses u WHERE u.asset_id IS NULL
),
project_downloads AS (
  SELECT pm.project_id, COUNT(*) AS downloads
  FROM downloads d JOIN project_media pm ON pm.asset_id = d.asset_id
  WHERE pm.project_id IN (SELECT id FROM scoped_projects)
  GROUP BY pm.project_id
),
per_project AS (
  SELECT sp.id, sp.name,
         (SELECT COUNT(DISTINCT pu.studio_video_id) FROM project_uses pu
           WHERE pu.project_id = sp.id AND pu.kind IN ('final_render','premiere_export')) AS videos,
         COALESCE(pd.downloads, 0) AS downloads,
         (SELECT COUNT(DISTINCT pu.asset_id) FROM project_uses pu
           WHERE pu.project_id = sp.id AND pu.asset_id IS NOT NULL) AS "assetsUsed"
  FROM scoped_projects sp
  LEFT JOIN project_downloads pd ON pd.project_id = sp.id
  WHERE sp.id IN (SELECT project_id FROM project_uses UNION SELECT project_id FROM project_downloads)
)
SELECT id AS "projectId", name, videos::int AS videos, downloads::int AS downloads,
       "assetsUsed"::int AS "assetsUsed"
FROM per_project
WHERE videos > 0 OR downloads > 0 OR "assetsUsed" > 0
ORDER BY videos DESC, downloads DESC, name ASC
LIMIT ${TOP_LIMIT}`;

/** `$6` time zone, `$7` bucket unit ('day' | 'week'). */
const TREND_SQL = `
WITH ${USAGE_CTES},
buckets AS (
  SELECT bucket
  FROM generate_series(
    date_trunc($7::text, $4::timestamptz AT TIME ZONE $6::text),
    date_trunc($7::text, ($5::timestamptz - interval '1 millisecond') AT TIME ZONE $6::text),
    ('1 ' || $7::text)::interval
  ) AS bucket
),
job_counts AS (
  SELECT date_trunc($7::text, occurred_at AT TIME ZONE $6::text) AS bucket,
         COUNT(DISTINCT job) FILTER (WHERE kind = 'final_render') AS final_renders,
         COUNT(DISTINCT job) FILTER (WHERE kind = 'premiere_export') AS premiere_exports
  FROM uses
  GROUP BY 1
),
download_counts AS (
  SELECT date_trunc($7::text, at AT TIME ZONE $6::text) AS bucket, COUNT(*) AS downloads
  FROM downloads
  GROUP BY 1
)
SELECT to_char(b.bucket, 'YYYY-MM-DD') AS date,
       COALESCE(j.final_renders, 0)::int AS "finalRenders",
       COALESCE(j.premiere_exports, 0)::int AS "premiereExports",
       COALESCE(d.downloads, 0)::int AS downloads
FROM buckets b
LEFT JOIN job_counts j ON j.bucket = b.bucket
LEFT JOIN download_counts d ON d.bucket = b.bucket
ORDER BY b.bucket`;

export type StatisticsStudioUsage = {
  totals: {
    projects: number;
    videos: number;
    finalRenders: number;
    premiereExports: number;
    downloads: number;
    assetsUsed: number;
  };
  topAssets: Array<{ assetId: string; name: string; videos: number; downloads: number }>;
  topProjects: Array<{
    projectId: string;
    name: string;
    videos: number;
    downloads: number;
    assetsUsed: number;
  }>;
  trend: Array<{ date: string; finalRenders: number; premiereExports: number; downloads: number }>;
};

/**
 * Footage use in AG Studio for the statistics page, over the caller's projects: totals, top 20
 * footage and projects, and a trend by day (by week over long periods). Downloads count each
 * footage file: direct downloads on ag-go (single, or in a zip) plus the footage files of
 * Premiere exports. A project counts the footage it holds (shared footage counts for each).
 */
@Injectable()
export class StatisticsStudioUsageService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
  ) {}

  async studioUsage(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsPeriodQueryDto,
  ): Promise<StatisticsStudioUsage> {
    const period = resolveStatisticsPeriod(query);
    const scope = await this.scopeService.resolve(context);
    const values = [...scopeValues(scope), period.from, period.effectiveTo];
    const [[totals], topAssets, topProjects, trend] = await Promise.all([
      this.dataSource.query(TOTALS_SQL, values) as Promise<Array<StatisticsStudioUsage['totals']>>,
      this.dataSource.query(TOP_ASSETS_SQL, values) as Promise<StatisticsStudioUsage['topAssets']>,
      this.dataSource.query(TOP_PROJECTS_SQL, values) as Promise<
        StatisticsStudioUsage['topProjects']
      >,
      this.dataSource.query(TREND_SQL, [...values, period.timeZone, period.granularity]) as Promise<
        StatisticsStudioUsage['trend']
      >,
    ]);
    const n = (value: unknown) => Number(value ?? 0);
    return {
      totals: {
        projects: n(totals?.projects),
        videos: n(totals?.videos),
        finalRenders: n(totals?.finalRenders),
        premiereExports: n(totals?.premiereExports),
        downloads: n(totals?.downloads),
        assetsUsed: n(totals?.assetsUsed),
      },
      topAssets: topAssets.map((row) => ({
        assetId: row.assetId,
        name: row.name,
        videos: n(row.videos),
        downloads: n(row.downloads),
      })),
      topProjects: topProjects.map((row) => ({
        projectId: row.projectId,
        name: row.name,
        videos: n(row.videos),
        downloads: n(row.downloads),
        assetsUsed: n(row.assetsUsed),
      })),
      trend: trend.map((row) => ({
        date: row.date,
        finalRenders: n(row.finalRenders),
        premiereExports: n(row.premiereExports),
        downloads: n(row.downloads),
      })),
    };
  }
}
