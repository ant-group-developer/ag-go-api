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
  type StatisticsBreakdownRange,
  type StatisticsBreakdownRow,
} from './statistics.types';

/*
 * Queries of the `period` range bind $4 from and $5 effectiveTo: only projects created and media
 * added in [$4, $5) are counted. Queries of the `all` range only bind the scope ($1..$3).
 */
const MEDIA_IN_PERIOD = `pm.created_at >= $4::timestamptz AND pm.created_at < $5::timestamptz`;

/** Project-level groupings: `key` (after `join`) is the group of each scoped project. */
const PROJECT_DIMENSIONS = {
  category: {
    join: '',
    key: 'p.category_id',
    labels: `LEFT JOIN categories x ON x.id = g.key`,
    label: 'x.name',
    code: 'NULL',
    flagUrl: 'NULL',
  },
  country: {
    join: '',
    key: 'p.country_id',
    labels: `LEFT JOIN countries x ON x.id = g.key`,
    label: 'x.name',
    code: 'x.code',
    flagUrl: 'x.flag_url',
  },
  // One row per (project, tag): a project with several tags counts in each of them.
  tag: {
    join: 'LEFT JOIN project_tags pt ON pt.project_id = sp.id',
    key: 'pt.tag_id',
    labels: `LEFT JOIN tags x ON x.id = g.key`,
    label: 'x.name',
    code: 'NULL',
    flagUrl: 'NULL',
  },
} as const;

type ProjectDimension = keyof typeof PROJECT_DIMENSIONS;

/**
 * The whole scope reads the media counters of each project (recomputed whenever its media
 * change) instead of joining every media and asset. The period counts the projects created and
 * the media added in the window, found through the `created_at` indexes.
 */
function projectBreakdownSql(dimension: ProjectDimension, range: StatisticsBreakdownRange): string {
  const config = PROJECT_DIMENSIONS[dimension];
  const projectKeys = `project_keys AS (
  SELECT
    sp.id AS project_id,
    sp.created_at,
    ${config.key} AS key,
    p.media_count,
    p.image_count,
    p.video_count
  FROM scoped_projects sp
  INNER JOIN projects p ON p.id = sp.id
  ${config.join}
)`;
  const grouped =
    range === 'all'
      ? `grouped AS (
  SELECT
    key,
    COUNT(*)::int AS projects,
    COALESCE(SUM(media_count), 0)::int AS media,
    COALESCE(SUM(image_count), 0)::int AS images,
    COALESCE(SUM(video_count), 0)::int AS videos
  FROM project_keys
  GROUP BY key
)`
      : `items AS (
  SELECT pk.key, 1 AS projects, 0 AS media, 0 AS images, 0 AS videos
  FROM project_keys pk
  WHERE pk.created_at >= $4::timestamptz AND pk.created_at < $5::timestamptz
  UNION ALL
  SELECT pk.key, 0, 1, (a.asset_type = 'image')::int, (a.asset_type = 'video')::int
  FROM project_media pm
  INNER JOIN project_keys pk ON pk.project_id = pm.project_id
  INNER JOIN assets a ON a.id = pm.asset_id
  WHERE ${MEDIA_IN_PERIOD}
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
)`;
  return `
WITH ${SCOPED_PROJECTS_CTE},
${projectKeys},
${grouped}
SELECT
  g.key::text AS key,
  ${config.label} AS label,
  ${config.code} AS code,
  ${config.flagUrl} AS "flagUrl",
  g.projects, g.media, g.images, g.videos
FROM grouped g
${config.labels}`;
}

/**
 * Media-level groupings. Resolution is the short edge of the source file (a portrait 1080x1920
 * video is 1080p), kept by Postgres in `assets.source_short_edge` from the metadata written once
 * the file is processed; files not processed yet have no size and land in the null group.
 */
const MEDIA_DIMENSIONS = {
  resolution: `CASE
      WHEN a.source_short_edge IS NULL THEN NULL
      WHEN a.source_short_edge >= 4320 THEN '8k'
      WHEN a.source_short_edge >= 2160 THEN '4k'
      WHEN a.source_short_edge >= 1440 THEN '1440p'
      WHEN a.source_short_edge >= 1080 THEN '1080p'
      WHEN a.source_short_edge >= 720 THEN '720p'
      WHEN a.source_short_edge >= 480 THEN '480p'
      ELSE 'sd'
    END`,
  extension: `NULLIF(lower(btrim(a.extension, '. ')), '')`,
} as const;

type MediaDimension = keyof typeof MEDIA_DIMENSIONS;

/** Grouped per (key, project) first, so projects are counted without a COUNT(DISTINCT) sort. */
function mediaBreakdownSql(dimension: MediaDimension, range: StatisticsBreakdownRange): string {
  return `
WITH ${SCOPED_PROJECTS_CTE},
per_project AS (
  SELECT
    ${MEDIA_DIMENSIONS[dimension]} AS key,
    pm.project_id,
    COUNT(*)::int AS media,
    COUNT(*) FILTER (WHERE a.asset_type = 'image')::int AS images,
    COUNT(*) FILTER (WHERE a.asset_type = 'video')::int AS videos
  FROM project_media pm
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
  INNER JOIN assets a ON a.id = pm.asset_id
  ${range === 'period' ? `WHERE ${MEDIA_IN_PERIOD}` : ''}
  GROUP BY 1, 2
)
SELECT
  key,
  NULL AS label,
  NULL AS code,
  NULL AS "flagUrl",
  COUNT(*)::int AS projects,
  SUM(media)::int AS media,
  SUM(images)::int AS images,
  SUM(videos)::int AS videos
FROM per_project
GROUP BY key`;
}

function breakdownSql(
  dimension: StatisticsBreakdownDimension,
  range: StatisticsBreakdownRange,
): string {
  return dimension === 'resolution' || dimension === 'extension'
    ? mediaBreakdownSql(dimension, range)
    : projectBreakdownSql(dimension, range);
}

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
    const scope = await this.scopeService.resolve(context);
    const values =
      range === 'all'
        ? scopeValues(scope)
        : [...scopeValues(scope), period.from, period.effectiveTo];
    const rows = scope.empty
      ? []
      : ((await this.dataSource.query(
          breakdownSql(query.dimension, range),
          values,
        )) as StatisticsBreakdownRow[]);

    const normalized = rows.map((row) => ({
      key: row.key ?? null,
      label: row.label ?? null,
      code: row.code ?? null,
      flagUrl: row.flagUrl ?? null,
      projects: Number(row.projects ?? 0),
      media: Number(row.media ?? 0),
      images: Number(row.images ?? 0),
      videos: Number(row.videos ?? 0),
    }));
    return {
      period: toPeriodInfo(period),
      dimension: query.dimension,
      range,
      totals: breakdownTotals(query.dimension, normalized),
      rows: sortRows(query.dimension, normalized),
    };
  }
}

/**
 * Totals are the sums of the rows wherever every project or media falls in exactly one row. A
 * project can fall in several resolutions or formats (through its media), so their project total
 * is null; tags repeat projects and their media, so they have no totals at all.
 */
export function breakdownTotals(
  dimension: StatisticsBreakdownDimension,
  rows: StatisticsBreakdownRow[],
): StatisticsBreakdown['totals'] {
  if (dimension === 'tag') {
    return null;
  }
  const sum = (key: 'projects' | 'media' | 'images' | 'videos') =>
    rows.reduce((total, row) => total + row[key], 0);
  return {
    projects: dimension === 'category' || dimension === 'country' ? sum('projects') : null,
    media: sum('media'),
    images: sum('images'),
    videos: sum('videos'),
  };
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
