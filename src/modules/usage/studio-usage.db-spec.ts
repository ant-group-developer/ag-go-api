/**
 * DB-level tests of AG Studio usage: events in (dedupe by event key), usage of an asset and a
 * project out. Runs against the test Postgres (port 55434).
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import type { StudioUsageEventDto } from './dto/studio-events.dto';
import { StudioUsageService } from './studio-usage.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let service: StudioUsageService;

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  service = new StudioUsageService(ds);
});

afterAll(async () => {
  if (ds.isInitialized) await ds.destroy();
});

function event(overrides: Partial<StudioUsageEventDto> = {}): StudioUsageEventDto {
  return {
    eventKey: `src:${randomUUID()}:added`,
    kind: 'source_added',
    occurredAt: '2026-10-10T08:00:00.000Z',
    assetId: randomUUID(),
    agGoProjectId: null,
    studioProjectId: 'prj_1',
    studioProjectName: 'Dự án 1',
    studioVideoId: null,
    studioVideoTitle: null,
    studioUserId: 'auth0|user-1',
    ...overrides,
  };
}

describe('StudioUsageService.record', () => {
  it('stores events once, even when resent or repeated in one request', async () => {
    const jobId = randomUUID();
    const assetId = randomUUID();
    const render = event({
      eventKey: `job:${jobId}:${assetId}`,
      kind: 'final_render',
      assetId,
      studioVideoId: 'vid_1',
      studioVideoTitle: 'Video 1',
    });
    const added = event();

    expect(await service.record([render, added, added])).toEqual({ accepted: 2, duplicates: 1 });
    expect(await service.record([render])).toEqual({ accepted: 0, duplicates: 1 });

    const [row] = await ds.query(
      `SELECT kind, asset_id, studio_job_id, studio_user_id, studio_video_title
       FROM studio_usage_events WHERE event_key = $1`,
      [render.eventKey],
    );
    expect(row).toEqual({
      kind: 'final_render',
      asset_id: assetId,
      studio_job_id: jobId,
      studio_user_id: 'user-1',
      studio_video_title: 'Video 1',
    });
  });
});

describe('StudioUsageService usage of an asset and a project', () => {
  async function insertAsset(): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO assets (id, asset_type, original_filename, mime_type, file_size_bytes, storage_provider,
         original_bucket, original_storage_key, processing_status, source_type, source_metadata, created_by)
       VALUES ($1,'video','clip.mp4','video/mp4',1000,'r2','ag-go',$2,'ready','local','{}','test')`,
      [id, `projects/p1/originals/${id}/clip.mp4`],
    );
    return id;
  }

  async function insertProject(): Promise<string> {
    const folderId = randomUUID();
    const name = `usage-${folderId.slice(0, 8)}`;
    await ds.query(
      `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, created_by)
       VALUES ($1, NULL, $2, $3, '{}', $4, 0, 'test')`,
      [folderId, name, name, name],
    );
    const projectId = randomUUID();
    await ds.query(
      `INSERT INTO projects (id, owner_user_id, folder_id, name) VALUES ($1,'test-user',$2,$3)`,
      [projectId, folderId, name],
    );
    return projectId;
  }

  async function link(projectId: string, assetId: string): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO project_media (id, project_id, asset_id, created_by) VALUES ($1,$2,$3,'test')`,
      [id, projectId, assetId],
    );
    return id;
  }

  it('counts Studio projects, videos, jobs and downloads', async () => {
    const projectId = await insertProject();
    const shared = await insertAsset();
    const other = await insertAsset();
    const sharedMedia = await link(projectId, shared);
    await link(projectId, other);
    const elsewhere = await insertProject();
    await link(elsewhere, shared);

    const job1 = randomUUID();
    const job2 = randomUUID();
    await service.record([
      event({ assetId: shared, studioProjectId: 'p1', occurredAt: '2026-10-01T00:00:00Z' }),
      event({ assetId: shared, studioProjectId: 'p2', occurredAt: '2026-10-02T00:00:00Z' }),
      event({
        eventKey: `job:${job1}:${shared}`,
        kind: 'final_render',
        assetId: shared,
        studioProjectId: 'p1',
        studioVideoId: 'v1',
        studioVideoTitle: 'Video 1',
        occurredAt: '2026-10-03T00:00:00Z',
      }),
      event({
        eventKey: `job:${job1}:${other}`,
        kind: 'final_render',
        assetId: other,
        studioProjectId: 'p1',
        studioVideoId: 'v1',
        occurredAt: '2026-10-03T00:00:00Z',
      }),
      event({
        eventKey: `job:${job2}:${shared}`,
        kind: 'premiere_export',
        assetId: shared,
        studioProjectId: 'p2',
        studioVideoId: 'v2',
        occurredAt: '2026-10-04T00:00:00Z',
      }),
      event({
        eventKey: `src:${randomUUID()}:removed`,
        kind: 'source_removed',
        assetId: shared,
        studioProjectId: 'p3',
        occurredAt: '2026-10-05T00:00:00Z',
      }),
      // The whole ag-go project added as a Studio source
      event({
        assetId: null,
        agGoProjectId: projectId,
        studioProjectId: 'p4',
        occurredAt: '2026-10-06T00:00:00Z',
      }),
    ]);

    // Two direct downloads of the shared footage: one single file, one file of a zip
    await ds.query(
      `INSERT INTO download_logs (external_user_id, project_id, project_media_id, asset_id, scope, download_type, status)
       VALUES ('u1',$1,$2,$3,'single','original','started'), ('u1',$1,$2,$3,'single','original','denied')`,
      [projectId, sharedMedia, shared],
    );
    const jobId = randomUUID();
    await ds.query(
      `INSERT INTO download_jobs (id, external_user_id, project_id, scope) VALUES ($1,'u1',$2,'project')`,
      [jobId, projectId],
    );
    await ds.query(
      `INSERT INTO download_job_items (id, download_job_id, project_media_id, asset_id, status)
       VALUES ($1,$2,$3,$4,'added')`,
      [randomUUID(), jobId, sharedMedia, shared],
    );

    const asset = await service.forAsset(shared);
    expect(asset).toMatchObject({
      projects: 3, // p1, p2, and p4 that added the whole project (p3 only removed it)
      videos: 2,
      finalRenders: 1,
      premiereExports: 1,
      downloads: { direct: 2, premiere: 1, total: 3 },
      lastUsedAt: '2026-10-06T00:00:00.000Z',
    });
    expect(asset.assets).toBeUndefined();
    expect(asset.recent.map((r) => r.kind)).toEqual([
      'source_added',
      'premiere_export',
      'final_render',
      'source_added',
      'source_added',
    ]);

    const project = await service.forProject(projectId);
    expect(project).toMatchObject({
      projects: 3,
      videos: 2,
      finalRenders: 1,
      premiereExports: 1,
      assets: 2,
      downloads: { direct: 2, premiere: 1, total: 3 },
    });

    // The other project holding the shared footage sees its use too, not the whole-project add
    const sharedProject = await service.forProject(elsewhere);
    expect(sharedProject).toMatchObject({ projects: 2, videos: 2, assets: 1 });
  });
});
