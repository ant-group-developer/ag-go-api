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

/** Footage usage AG Studio reports, and the usage counts read from it. */
@Injectable()
export class StudioUsageService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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
