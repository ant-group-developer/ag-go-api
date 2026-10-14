/**
 * DB-level test of the Studio usage statistics: real SQL over the test Postgres (port 55434),
 * scoped to one folder so data left by other suites does not count.
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { StudioUsageService } from '../usage/studio-usage.service';
import type { StatisticsScopeService } from './statistics-scope.service';
import { StatisticsStudioUsageService } from './statistics-studio-usage.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
});

afterAll(async () => {
  if (ds.isInitialized) await ds.destroy();
});

async function insertAsset(name: string): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO assets (id, asset_type, original_filename, mime_type, file_size_bytes, storage_provider,
       original_bucket, original_storage_key, processing_status, source_type, source_metadata, created_by)
     VALUES ($1,'video',$2,'video/mp4',1000,'r2','ag-go',$3,'ready','local','{}','test')`,
    [id, name, `projects/p1/originals/${id}/${name}`],
  );
  return id;
}

it('sums Studio use and downloads of the footage in scope over the period', async () => {
  const folderId = randomUUID();
  const folderName = `stats-${folderId.slice(0, 8)}`;
  await ds.query(
    `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, created_by)
     VALUES ($1, NULL, $2, $3, '{}', $4, 0, 'test')`,
    [folderId, folderName, folderName, folderName],
  );
  const projectId = randomUUID();
  await ds.query(
    `INSERT INTO projects (id, owner_user_id, folder_id, name) VALUES ($1,'test-user',$2,'Hoa Lư')`,
    [projectId, folderId],
  );
  const a = await insertAsset('a.mp4');
  const b = await insertAsset('b.mp4');
  const outside = await insertAsset('outside.mp4');
  const media = randomUUID();
  await ds.query(
    `INSERT INTO project_media (id, project_id, asset_id, created_by) VALUES ($1,$2,$3,'test'), ($4,$2,$5,'test')`,
    [media, projectId, a, randomUUID(), b],
  );

  const job = randomUUID();
  const export1 = randomUUID();
  const base = {
    occurredAt: '2026-09-02T03:00:00Z',
    agGoProjectId: null,
    studioProjectName: 'S',
    studioVideoTitle: null,
    studioUserId: null,
  };
  await new StudioUsageService(ds).record([
    {
      ...base,
      eventKey: `src:${randomUUID()}:added`,
      kind: 'source_added',
      assetId: a,
      studioProjectId: 's1',
      studioVideoId: null,
    },
    {
      ...base,
      eventKey: `job:${job}:${a}`,
      kind: 'final_render',
      assetId: a,
      studioProjectId: 's1',
      studioVideoId: 'v1',
    },
    {
      ...base,
      eventKey: `job:${job}:${b}`,
      kind: 'final_render',
      assetId: b,
      studioProjectId: 's1',
      studioVideoId: 'v1',
    },
    {
      ...base,
      eventKey: `job:${export1}:${a}`,
      kind: 'premiere_export',
      assetId: a,
      studioProjectId: 's2',
      studioVideoId: 'v2',
      occurredAt: '2026-09-03T03:00:00Z',
    },
    // Outside the scope and outside the period: not counted
    {
      ...base,
      eventKey: `job:${randomUUID()}:${outside}`,
      kind: 'final_render',
      assetId: outside,
      studioProjectId: 's9',
      studioVideoId: 'v9',
    },
    {
      ...base,
      eventKey: `job:${randomUUID()}:${a}`,
      kind: 'final_render',
      assetId: a,
      studioProjectId: 's1',
      studioVideoId: 'v8',
      occurredAt: '2026-08-01T00:00:00Z',
    },
  ]);
  await ds.query(
    `INSERT INTO download_logs (external_user_id, project_id, project_media_id, asset_id, scope, download_type, status, created_at)
     VALUES ('u1',$1,$2,$3,'single','original','started','2026-09-02T05:00:00Z')`,
    [projectId, media, a],
  );

  const scopeService = {
    resolve: jest.fn().mockResolvedValue({
      folderIds: [folderId],
      isAdmin: false,
      userId: 'test-user',
      empty: false,
    }),
  } as unknown as StatisticsScopeService;
  const service = new StatisticsStudioUsageService(ds, scopeService);
  const result = await service.studioUsage(
    { userId: 'test-user', userType: 'USER' },
    { from: '2026-09-01T00:00:00+07:00', to: '2026-09-05T00:00:00+07:00', tz: 'Asia/Ho_Chi_Minh' },
  );

  expect(result.totals).toEqual({
    projects: 2,
    videos: 2,
    finalRenders: 1,
    premiereExports: 1,
    downloads: 2, // one direct download + one footage file of the Premiere export
    assetsUsed: 2,
  });
  expect(result.topAssets).toEqual([
    { assetId: a, name: 'a.mp4', videos: 2, downloads: 2 },
    { assetId: b, name: 'b.mp4', videos: 1, downloads: 0 },
  ]);
  expect(result.topProjects).toEqual([
    { projectId, name: 'Hoa Lư', videos: 2, downloads: 2, assetsUsed: 2 },
  ]);
  expect(result.trend.map((point) => point.date)).toEqual([
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
    '2026-09-04',
  ]);
  expect(result.trend[1]).toEqual({
    date: '2026-09-02',
    finalRenders: 1,
    premiereExports: 0,
    downloads: 1,
  });
  expect(result.trend[2]).toMatchObject({ premiereExports: 1, downloads: 1 });
});
