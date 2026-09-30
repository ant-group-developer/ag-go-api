import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsBreakdownQueryDto } from './dto/statistics-breakdown-query.dto';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { resolveStatisticsPeriod, toPeriodInfo } from './statistics-period';
import { StatisticsScopeService } from './statistics-scope.service';
import {
  STATISTICS_RESOLUTION_CLASSES,
  type StatisticsBreakdown,
  type StatisticsBreakdownDimension,
  type StatisticsBreakdownRow,
} from './statistics.types';

/*
 * Every query below binds $4 from, $5 effectiveTo and $6 "whole scope" (true ignores the window).
 * With the window, only projects created in [$4, $5) and media added in [$4, $5) are counted.
 */
const PROJECT_IN_RANGE = `($6::boolean OR (pk.created_at >= $4::timestamptz AND pk.created_at < $5::timestamptz))`;
const MEDIA_IN_RANGE = `($6::boolean OR (pm.created_at >= $4::timestamptz AND pm.created_at < $5::timestamptz))`;

/** Project-level groupings: `keys` maps each scoped project to its group(s), `labels` names them. */
const PROJECT_DIMENSIONS = {
  category: {
    keys: `SELECT sp.id AS project_id, sp.created_at, p.category_id AS key
      FROM scoped_projects sp INNER JOIN projects p ON p.id = sp.id`,
    labels: `LEFT JOIN categories x ON x.id = g.key`,
    label: 'x.name',
    code: 'NULL',
    flagUrl: 'NULL',
  },
  country: {
    keys: `SELECT sp.id AS project_id, sp.created_at, p.country_id AS key
      FROM scoped_projects sp INNER JOIN projects p ON p.id = sp.id`,
    labels: `LEFT JOIN countries x ON x.id = g.key`,
    label: 'x.name',
    code: 'x.code',
    flagUrl: 'x.flag_url',
  },
  // One row per (project, tag): a project with several tags counts in each of them.
  tag: {
    keys: `SELECT sp.id AS project_id, sp.created_at, pt.tag_id AS key
      FROM scoped_projects sp LEFT JOIN project_tags pt ON pt.project_id = sp.id`,
    labels: `LEFT JOIN tags x ON x.id = g.key`,
    label: 'x.name',
    code: 'NULL',
    flagUrl: 'NULL',
  },
} as const;

type ProjectDimension = keyof typeof PROJECT_DIMENSIONS;

function projectBreakdownSql(dimension: ProjectDimension): string {
  const config = PROJECT_DIMENSIONS[dimension];
  return `
WITH ${SCOPED_PROJECTS_CTE},
project_keys AS (
  ${config.keys}
),
items AS (
  SELECT pk.key, 1 AS projects, 0 AS media, 0 AS images, 0 AS videos
  FROM project_keys pk
  WHERE ${PROJECT_IN_RANGE}
  UNION ALL
  SELECT pk.key, 0, 1, (a.asset_type = 'image')::int, (a.asset_type = 'video')::int
  FROM project_keys pk
  INNER JOIN project_media pm ON pm.project_id = pk.project_id
  INNER JOIN assets a ON a.id = pm.asset_id
  WHERE ${MEDIA_IN_RANGE}
),
grouped AS (
  SELECT
    key,
    SUM(projects)::int AS projects,
    SUM(media)::int AS media,
    SUM(images)::int AS images,
    SUM(videos)::int AS videos
  FROM items
  GROUP BY key
)
SELECT
  g.key::text AS key,
  ${config.label} AS label,
  ${config.code} AS code,
  ${config.flagUrl} AS "flagUrl",
  g.projects, g.media, g.images, g.videos
FROM grouped g
${config.labels}`;
}

/** A jsonb metadata field as a number, or null when it is missing or not numeric. */
function metadataNumber(field: string): string {
  return `CASE WHEN a.source_metadata->>'${field}' ~ '^[0-9]+(\\.[0-9]+)?$'
    THEN (a.source_metadata->>'${field}')::numeric END`;
}

/**
 * Media-level groupings. Resolution is the short edge of the source file (a portrait 1080x1920
 * video is 1080p), read from the metadata written once the file is processed; files not
 * processed yet have no size and land in the null group.
 */
const MEDIA_DIMENSIONS = {
  resolution: {
    joins: `CROSS JOIN LATERAL (
      SELECT CASE WHEN d.w > 0 AND d.h > 0 THEN LEAST(d.w, d.h) END AS short_edge
      FROM (SELECT ${metadataNumber('width')} AS w, ${metadataNumber('height')} AS h) d
    ) s`,
    key: `CASE
      WHEN s.short_edge IS NULL THEN NULL
      WHEN s.short_edge >= 4320 THEN '8k'
      WHEN s.short_edge >= 2160 THEN '4k'
      WHEN s.short_edge >= 1440 THEN '1440p'
      WHEN s.short_edge >= 1080 THEN '1080p'
      WHEN s.short_edge >= 720 THEN '720p'
      WHEN s.short_edge >= 480 THEN '480p'
      ELSE 'sd'
    END`,
  },
  extension: {
    joins: '',
    key: `NULLIF(lower(btrim(a.extension, '. ')), '')`,
  },
} as const;

type MediaDimension = keyof typeof MEDIA_DIMENSIONS;

function mediaBreakdownSql(dimension: MediaDimension): string {
  const config = MEDIA_DIMENSIONS[dimension];
  return `
WITH ${SCOPED_PROJECTS_CTE},
media AS (
  SELECT pm.project_id, a.asset_type, ${config.key} AS key
  FROM project_media pm
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
  INNER JOIN assets a ON a.id = pm.asset_id
  ${config.joins}
  WHERE ${MEDIA_IN_RANGE}
)
SELECT
  key,
  NULL AS label,
  NULL AS code,
  NULL AS "flagUrl",
  COUNT(DISTINCT project_id)::int AS projects,
  COUNT(*)::int AS media,
  COUNT(*) FILTER (WHERE asset_type = 'image')::int AS images,
  COUNT(*) FILTER (WHERE asset_type = 'video')::int AS videos
FROM media
GROUP BY key`;
}

const TOTALS_SQL = `
WITH ${SCOPED_PROJECTS_CTE}
SELECT
  (
    SELECT COUNT(*)::int FROM scoped_projects pk WHERE ${PROJECT_IN_RANGE}
  ) AS projects,
  COUNT(*)::int AS media,
  COUNT(*) FILTER (WHERE a.asset_type = 'image')::int AS images,
  COUNT(*) FILTER (WHERE a.asset_type = 'video')::int AS videos
FROM project_media pm
INNER JOIN scoped_projects sp ON sp.id = pm.project_id
INNER JOIN assets a ON a.id = pm.asset_id
WHERE ${MEDIA_IN_RANGE}`;

function breakdownSql(dimension: StatisticsBreakdownDimension): string {
  return dimension === 'resolution' || dimension === 'extension'
    ? mediaBreakdownSql(dimension)
    : projectBreakdownSql(dimension);
}

type TotalsRow = { projects: number; media: number; images: number; videos: number };

@Injectable()
export class StatisticsBreakdownService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
  ) {}

  async breakdown(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsBreakdownQueryDto,
  ): Promise<StatisticsBreakdown> {
    const period = resolveStatisticsPeriod(query);
    const range = query.range ?? 'all';
    const result: StatisticsBreakdown = {
      period: toPeriodInfo(period),
      dimension: query.dimension,
      range,
      totals: { projects: 0, media: 0, images: 0, videos: 0 },
      rows: [],
    };
    const scope = await this.scopeService.resolve(context);
    if (scope.empty) {
      return result;
    }

    const values = [...scopeValues(scope), period.from, period.effectiveTo, range === 'all'];
    const [rows, totals] = (await Promise.all([
      this.dataSource.query(breakdownSql(query.dimension), values),
      this.dataSource.query(TOTALS_SQL, values),
    ])) as [StatisticsBreakdownRow[], TotalsRow[]];

    const total = totals[0];
    result.totals = {
      projects: Number(total?.projects ?? 0),
      media: Number(total?.media ?? 0),
      images: Number(total?.images ?? 0),
      videos: Number(total?.videos ?? 0),
    };
    result.rows = sortRows(
      query.dimension,
      rows.map((row) => ({
        key: row.key ?? null,
        label: row.label ?? null,
        code: row.code ?? null,
        flagUrl: row.flagUrl ?? null,
        projects: Number(row.projects ?? 0),
        media: Number(row.media ?? 0),
        images: Number(row.images ?? 0),
        videos: Number(row.videos ?? 0),
      })),
    );
    return result;
  }
}

/**
 * Resolution classes keep their natural order (highest first); other groups are ranked by
 * projects (category, country, tag) or media (extension). The null group always comes last.
 */
export function sortRows(
  dimension: StatisticsBreakdownDimension,
  rows: StatisticsBreakdownRow[],
): StatisticsBreakdownRow[] {
  const resolutionOrder = (key: string) =>
    STATISTICS_RESOLUTION_CLASSES.indexOf(key as (typeof STATISTICS_RESOLUTION_CLASSES)[number]);
  return [...rows].sort((a, b) => {
    if (a.key === null || b.key === null) {
      return Number(a.key === null) - Number(b.key === null);
    }
    if (dimension === 'resolution') {
      return resolutionOrder(a.key) - resolutionOrder(b.key);
    }
    const primary =
      dimension === 'extension' ? b.media - a.media : b.projects - a.projects || b.media - a.media;
    return primary || (a.label ?? a.key).localeCompare(b.label ?? b.key);
  });
}
