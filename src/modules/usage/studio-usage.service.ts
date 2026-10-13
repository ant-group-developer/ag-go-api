import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { StudioUsageEventDto } from './dto/studio-events.dto';

/** `job:<jobId>:<assetId>`: Studio's key of one footage of a final render or Premiere export. */
const JOB_EVENT_KEY = /^job:([^:]{1,100}):/;

/** Columns of one inserted event, in order. */
const COLUMNS = [
  'event_key',
  'kind',
  'asset_id',
  'ag_go_project_id',
  'studio_job_id',
  'studio_project_id',
  'studio_project_name',
  'studio_video_id',
  'studio_video_title',
  'studio_user_id',
  'occurred_at',
] as const;

/** How AG Studio used one footage or the footage of one project (H4 contract). */
export type StudioUsage = {
  projects: number;
  videos: number;
  finalRenders: number;
  premiereExports: number;
  downloads: { direct: number; premiere: number; total: number };
  /** Only for a project: how many of its footage Studio used. */
  assets?: number;
  lastUsedAt: string | null;
  recent: Array<{
    kind: string;
    occurredAt: string;
    studioProjectId: string;
    studioProjectName: string;
    studioVideoId: string | null;
    studioVideoTitle: string | null;
    studioUserId: string | null;
    assetId: string | null;
  }>;
};

/** Studio videos listed under "recent". */
const RECENT_LIMIT = 20;

/**
 * Counts over the events of a footage set. `$1`: the asset ids. `events` keeps the uses (not
 * `source_removed`) of those assets, plus a whole ag-go project added as a source when it holds
 * one of them (`$2`: that project when the set is a project, else matched through project_media).
 * - projects: Studio projects that added the footage or rendered / exported it;
 * - videos: Studio videos with the footage in a final render or a Premiere export;
 * - finalRenders / premiereExports: Studio jobs (one event per footage of a job);
 * - downloads: direct downloads on ag-go (single files, and each file of a zip) plus the
 *   footage files of Premiere exports.
 */
const USAGE_SQL = `
WITH events AS (
  SELECT e.*
  FROM studio_usage_events e
  WHERE e.kind <> 'source_removed'
    AND (e.asset_id = ANY($1::uuid[])
      OR (e.asset_id IS NULL AND e.ag_go_project_id IS NOT NULL
          AND (e.ag_go_project_id = $2::uuid
            OR ($2::uuid IS NULL AND EXISTS (
                  SELECT 1 FROM project_media pm
                  WHERE pm.project_id = e.ag_go_project_id AND pm.asset_id = ANY($1::uuid[]))))))
)
SELECT
  (SELECT COUNT(DISTINCT studio_project_id) FROM events)::int AS projects,
  (SELECT COUNT(DISTINCT studio_video_id) FROM events
    WHERE kind IN ('final_render','premiere_export') AND studio_video_id IS NOT NULL)::int AS videos,
  (SELECT COUNT(DISTINCT COALESCE(studio_job_id, event_key)) FROM events WHERE kind = 'final_render')::int AS "finalRenders",
  (SELECT COUNT(DISTINCT COALESCE(studio_job_id, event_key)) FROM events WHERE kind = 'premiere_export')::int AS "premiereExports",
  (SELECT COUNT(*) FROM events WHERE kind = 'premiere_export' AND asset_id IS NOT NULL)::int AS "premiereFiles",
  (SELECT COUNT(DISTINCT asset_id) FROM events WHERE asset_id IS NOT NULL)::int AS assets,
  (SELECT MAX(occurred_at) FROM events) AS "lastUsedAt",
  ((SELECT COUNT(*) FROM download_logs dl
     WHERE dl.asset_id = ANY($1::uuid[]) AND dl.status = 'started')
   + (SELECT COUNT(*) FROM download_job_items di
     WHERE di.asset_id = ANY($1::uuid[]) AND di.status <> 'failed'))::int AS "directDownloads"
`;

const RECENT_SQL = `
SELECT e.kind, e.occurred_at AS "occurredAt", e.studio_project_id AS "studioProjectId",
       e.studio_project_name AS "studioProjectName", e.studio_video_id AS "studioVideoId",
       e.studio_video_title AS "studioVideoTitle", e.studio_user_id AS "studioUserId",
       e.asset_id AS "assetId"
FROM studio_usage_events e
WHERE e.kind <> 'source_removed'
  AND (e.asset_id = ANY($1::uuid[])
    OR (e.asset_id IS NULL AND e.ag_go_project_id IS NOT NULL
        AND (e.ag_go_project_id = $2::uuid
          OR ($2::uuid IS NULL AND EXISTS (
                SELECT 1 FROM project_media pm
                WHERE pm.project_id = e.ag_go_project_id AND pm.asset_id = ANY($1::uuid[]))))))
ORDER BY e.occurred_at DESC, e.id DESC
LIMIT ${RECENT_LIMIT}
`;

/** Footage usage AG Studio reports, and the usage counts read from it. */
@Injectable()
export class StudioUsageService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Usage of one footage. */
  async forAsset(assetId: string): Promise<StudioUsage> {
    const usage = await this.usage([assetId], null);
    delete usage.assets;
    return usage;
  }

  /**
   * Usage of a project's footage: every footage it holds counts, including footage shared with
   * other projects, plus the project added to Studio as a whole.
   */
  async forProject(projectId: string): Promise<StudioUsage> {
    const rows = await this.dataSource.query<{ asset_id: string }[]>(
      `SELECT DISTINCT asset_id FROM project_media WHERE project_id = $1`,
      [projectId],
    );
    return this.usage(
      rows.map((row) => row.asset_id),
      projectId,
    );
  }

  private async usage(assetIds: string[], projectId: string | null): Promise<StudioUsage> {
    const [[counts], recent] = await Promise.all([
      this.dataSource.query<
        {
          projects: number;
          videos: number;
          finalRenders: number;
          premiereExports: number;
          premiereFiles: number;
          assets: number;
          lastUsedAt: Date | null;
          directDownloads: number;
        }[]
      >(USAGE_SQL, [assetIds, projectId]),
      this.dataSource.query<
        Array<Omit<StudioUsage['recent'][number], 'occurredAt'> & { occurredAt: Date }>
      >(RECENT_SQL, [assetIds, projectId]),
    ]);
    const direct = Number(counts?.directDownloads ?? 0);
    const premiere = Number(counts?.premiereFiles ?? 0);
    return {
      projects: Number(counts?.projects ?? 0),
      videos: Number(counts?.videos ?? 0),
      finalRenders: Number(counts?.finalRenders ?? 0),
      premiereExports: Number(counts?.premiereExports ?? 0),
      downloads: { direct, premiere, total: direct + premiere },
      assets: Number(counts?.assets ?? 0),
      lastUsedAt: counts?.lastUsedAt ? new Date(counts.lastUsedAt).toISOString() : null,
      recent: recent.map((row) => ({ ...row, occurredAt: new Date(row.occurredAt).toISOString() })),
    };
  }

  /**
   * Stores the events; one already stored (same `eventKey`, also twice in one request) is a
   * duplicate and not counted again.
   */
  async record(events: StudioUsageEventDto[]): Promise<{ accepted: number; duplicates: number }> {
    if (events.length === 0) return { accepted: 0, duplicates: 0 };
    const values: unknown[] = [];
    const rows = events.map((event) => {
      const row = [
        event.eventKey,
        event.kind,
        event.assetId ?? null,
        event.agGoProjectId ?? null,
        JOB_EVENT_KEY.exec(event.eventKey)?.[1] ?? null,
        event.studioProjectId,
        event.studioProjectName.slice(0, 500),
        event.studioVideoId ?? null,
        event.studioVideoTitle?.slice(0, 500) ?? null,
        normalizeUserId(event.studioUserId),
        new Date(event.occurredAt),
      ];
      const placeholders = row.map((value) => `$${values.push(value)}`);
      return `(${placeholders.join(', ')})`;
    });
    const inserted = await this.dataSource.query<{ id: string }[]>(
      `INSERT INTO studio_usage_events (${COLUMNS.join(', ')})
       VALUES ${rows.join(',\n')}
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      values,
    );
    return { accepted: inserted.length, duplicates: events.length - inserted.length };
  }
}

/** Same id a user's own token gives: the Auth0 subject without `auth0|`. */
export function normalizeUserId(subject: string | null | undefined): string | null {
  const value = subject?.trim();
  if (!value) return null;
  return (value.startsWith('auth0|') ? value.slice('auth0|'.length) : value).slice(0, 128);
}
