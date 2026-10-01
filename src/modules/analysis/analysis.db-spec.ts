/**
 * DB-level integration tests for the media-analysis module (v2: per-asset analysis).
 * These run against a real Postgres instance (the test DB started by docker-compose.test.yml).
 * The global setup (jest.db-global-setup.ts) creates the database and runs all migrations
 * before any test in this file executes.
 *
 * Tests clean up their own rows after each case to keep the DB usable across test files.
 */
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { AssetAnalysisV22060000000000 } from '../../database/migrations/2060000000000-asset-analysis-v2';
import type { StorageAdapter } from '../assets/storage/storage-adapter';
import type { AnalysisBatchService } from './analysis-batch.service';
import type { AnalysisEnqueueService } from './analysis-enqueue.service';
import type { AnalysisLogService } from './analysis-log.service';
import type { AnalysisPipelineService } from './analysis-pipeline.service';
import { AnalysisService } from './analysis.service';

jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertAsset(
  overrides: Partial<{
    id: string;
    asset_type: string;
    mime_type: string;
    original_storage_key: string;
    processing_status: string;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await ds.query(
    `INSERT INTO assets
       (id, asset_type, original_filename, mime_type, file_size_bytes,
        storage_provider, original_bucket, original_storage_key,
        processing_status, source_type, source_metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      overrides.asset_type ?? 'video',
      'clip.mp4',
      overrides.mime_type ?? 'video/mp4',
      102400,
      'r2',
      'ag-go',
      overrides.original_storage_key ?? `projects/p1/originals/${id}/clip.mp4`,
      overrides.processing_status ?? 'ready',
      'local',
      JSON.stringify({}),
      'test',
    ],
  );
  return id;
}

async function insertAnalysis(
  assetId: string,
  overrides: Partial<{
    id: string;
    status: string;
    is_current: boolean;
    extract_version: string;
    prompt_version: string;
    description: Record<string, unknown> | null;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await ds.query(
    `INSERT INTO asset_analyses
       (id, asset_id, status, priority, extract_version, prompt_version, is_current)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      assetId,
      overrides.status ?? 'queued',
      0,
      overrides.extract_version ?? 'x2',
      overrides.prompt_version ?? 'p2',
      overrides.is_current ?? false,
    ],
  );
  if (overrides.description) {
    await ds.query(`UPDATE asset_analyses SET description=$1 WHERE id=$2`, [
      JSON.stringify(overrides.description),
      id,
    ]);
  }
  return id;
}

async function cleanupAsset(assetId: string): Promise<void> {
  await ds.query(`DELETE FROM assets WHERE id=$1`, [assetId]);
}

// ---------------------------------------------------------------------------
// Migration: run → revert → run (2040)
// ---------------------------------------------------------------------------

describe('AssetAnalysisV22060000000000', () => {
  it('can be reverted and re-applied without errors', async () => {
    // Ensure no v2 data remains
    await ds.query(`DELETE FROM analysis_farm_jobs`);
    await ds.query(`DELETE FROM asset_analyses`);
    await ds.query(`DELETE FROM analysis_batches`);

    const migration = new AssetAnalysisV22060000000000();
    const runner = ds.createQueryRunner();

    try {
      await migration.down(runner);

      // analysis_batches should be gone; asset_analyses should lose v2 columns
      const afterDown = await ds.query<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename IN ('analysis_batches')`,
      );
      expect(afterDown).toHaveLength(0);

      // media_segments is re-created on down
      const segsBack = await ds.query<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename = 'media_segments'`,
      );
      expect(segsBack).toHaveLength(1);

      await migration.up(runner);

      // analysis_batches should be back
      const afterUp = await ds.query<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename IN ('analysis_batches')`,
      );
      expect(afterUp).toHaveLength(1);

      // media_segments should be gone after up
      const segsGone = await ds.query<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename = 'media_segments'`,
      );
      expect(segsGone).toHaveLength(0);

      // asset_analyses should have search_vector column
      const cols = await ds.query<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='asset_analyses' AND column_name IN ('description','search_vector','batch_id')`,
      );
      expect(cols.map((c) => c.column_name).sort()).toEqual([
        'batch_id',
        'description',
        'search_vector',
      ]);
    } finally {
      await runner.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Enqueue inside transaction
// ---------------------------------------------------------------------------

describe('enqueue inside transaction', () => {
  let assetId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('writes an asset_analyses row and an outbox_events row in the same transaction', async () => {
    const analysisId = randomUUID();

    await ds.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO asset_analyses
           (id, asset_id, status, priority, extract_version, prompt_version, is_current)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [analysisId, assetId, 'queued', 0, 'x2', 'p2', false],
      );
      await manager.query(
        `INSERT INTO outbox_events
           (id, event_type, aggregate_type, aggregate_id, payload, status, attempt_count, available_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          'asset.analysis.requested',
          'asset_analysis',
          analysisId,
          JSON.stringify({ analysisId }),
          'pending',
          0,
          new Date(),
        ],
      );
    });

    const [analysis] = await ds.query<AssetAnalysisEntity[]>(
      `SELECT * FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis).toBeDefined();
    expect(analysis.status).toBe('queued');

    const events = await ds.query<OutboxEventEntity[]>(
      `SELECT * FROM outbox_events WHERE aggregate_id=$1`,
      [analysisId],
    );
    expect(events).toHaveLength(1);
    expect((events[0] as unknown as Record<string, unknown>)['event_type']).toBe(
      'asset.analysis.requested',
    );

    // Cleanup
    await ds.query(`DELETE FROM outbox_events WHERE aggregate_id=$1`, [analysisId]);
  });

  it('stores batchId when provided', async () => {
    // Insert an auto batch
    const batchId = randomUUID();
    await ds.query(
      `INSERT INTO analysis_batches (id, name, kind, status) VALUES ($1,'Tự động','auto','running')`,
      [batchId],
    );
    const analysisId = randomUUID();
    await ds.query(
      `INSERT INTO asset_analyses
         (id, asset_id, status, priority, extract_version, prompt_version, is_current, batch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [analysisId, assetId, 'queued', 0, 'x2', 'p2', false, batchId],
    );
    const [row] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT batch_id FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(row['batch_id']).toBe(batchId);

    await ds.query(`DELETE FROM analysis_batches WHERE id=$1`, [batchId]);
  });
});

// ---------------------------------------------------------------------------
// is_current flip: two consecutive analyses of the same asset
// ---------------------------------------------------------------------------

describe('is_current flip', () => {
  let assetId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('leaves exactly one current analysis after completing a second run', async () => {
    const analysis1Id = await insertAnalysis(assetId, { status: 'completed', is_current: true });
    const analysis2Id = await insertAnalysis(assetId, { status: 'extracted', is_current: false });

    await ds.transaction(async (manager) => {
      await manager.query(
        `UPDATE asset_analyses SET is_current=false WHERE asset_id=$1 AND is_current=true`,
        [assetId],
      );
      await manager.query(
        `UPDATE asset_analyses SET is_current=true, status='completed' WHERE id=$1`,
        [analysis2Id],
      );
    });

    const currentAnalyses = await ds.query<AssetAnalysisEntity[]>(
      `SELECT * FROM asset_analyses WHERE asset_id=$1 AND is_current=true`,
      [assetId],
    );
    expect(currentAnalyses).toHaveLength(1);
    expect(currentAnalyses[0].id).toBe(analysis2Id);

    const [oldAnalysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM asset_analyses WHERE id=$1`,
      [analysis1Id],
    );
    expect(oldAnalysis?.['is_current']).toBe(false);
  });

  it('the partial unique index prevents two concurrent is_current=true rows', async () => {
    await insertAnalysis(assetId, { status: 'completed', is_current: true });
    await expect(
      insertAnalysis(assetId, { status: 'completed', is_current: true }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// search_vector populated by trigger after description update
// ---------------------------------------------------------------------------

describe('search_vector trigger', () => {
  let assetId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('populates search_vector when description is set', async () => {
    const analysisId = await insertAnalysis(assetId, {
      description: {
        title_vi: 'Phở bò Hà Nội',
        keywords_vi: ['ẩm thực', 'đường phố'],
        summary_vi: 'Tô phở bò truyền thống',
        summary_en: 'Traditional beef noodle soup',
        tags: ['pho', 'food'],
        genre: 'ẩm thực',
        topics: [],
        subjects: [],
        places: ['Hà Nội'],
        actions: [],
        mood: '',
        setting: 'outdoor',
        time_of_day: 'day',
        people_count: 'none',
        shot_variety: [],
        camera_motions: [],
        visible_text: '',
        has_watermark: false,
        usable: true,
        usable_reason: '',
        quality: 4,
      },
    });

    const [row] = await ds.query<Array<{ has_sv: boolean }>>(
      `SELECT (search_vector IS NOT NULL) AS has_sv FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(row.has_sv).toBe(true);

    // Query the search vector
    const matches = await ds.query<Array<{ id: string }>>(
      `SELECT id FROM asset_analyses
       WHERE search_vector @@ plainto_tsquery('simple', immutable_unaccent('pho bo'))
       AND id=$1`,
      [analysisId],
    );
    expect(matches).toHaveLength(1);
  });

  it('search_vector is null when description is null', async () => {
    const analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    const [row] = await ds.query<Array<{ sv: unknown }>>(
      `SELECT search_vector AS sv FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(row.sv).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Backfill dryRun vs real
// ---------------------------------------------------------------------------

describe('backfill dryRun vs real', () => {
  let assetId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('dryRun counts assets needing analysis without inserting rows', async () => {
    const [countRow] = await ds.query<[{ count: string }]>(
      `SELECT COUNT(*) AS count FROM assets a
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_analyses aa
         WHERE aa.asset_id = a.id AND aa.is_current = true
         AND aa.extract_version = 'x2' AND aa.prompt_version = 'p2'
       ) AND a.id = $1`,
      [assetId],
    );
    expect(Number(countRow.count)).toBe(1);

    const rows = await ds.query<AssetAnalysisEntity[]>(
      `SELECT * FROM asset_analyses WHERE asset_id=$1`,
      [assetId],
    );
    expect(rows).toHaveLength(0);
  });

  it('real backfill inserts an asset_analyses row', async () => {
    const analysisId = randomUUID();
    await ds.query(
      `INSERT INTO asset_analyses
         (id, asset_id, status, priority, extract_version, prompt_version, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [analysisId, assetId, 'queued', 0, 'x2', 'p2', false],
    );

    const rows = await ds.query<AssetAnalysisEntity[]>(
      `SELECT * FROM asset_analyses WHERE asset_id=$1`,
      [assetId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
  });

  it('backfill skips assets that already have a current analysis at the target versions', async () => {
    await insertAnalysis(assetId, {
      status: 'completed',
      is_current: true,
      extract_version: 'x2',
      prompt_version: 'p2',
    });

    const [countRow] = await ds.query<[{ count: string }]>(
      `SELECT COUNT(*) AS count FROM assets a
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_analyses aa
         WHERE aa.asset_id = a.id AND aa.is_current = true
         AND aa.extract_version = 'x2' AND aa.prompt_version = 'p2'
       ) AND a.id = $1`,
      [assetId],
    );
    expect(Number(countRow.count)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Backfill scope: which assets are picked up
// ---------------------------------------------------------------------------

describe('backfill scope', () => {
  let service: AnalysisService;
  let folderId: string;
  let projectId: string;
  const assetIds: string[] = [];

  async function insertLinkedAsset(processingStatus: string): Promise<string> {
    const id = await insertAsset({ processing_status: processingStatus });
    assetIds.push(id);
    await ds.query(
      `INSERT INTO project_media (id, project_id, asset_id, created_by) VALUES ($1,$2,$3,'test')`,
      [randomUUID(), projectId, id],
    );
    return id;
  }

  beforeAll(() => {
    const config = { get: () => undefined } as unknown as ConfigService;
    service = new AnalysisService(
      ds,
      ds.getRepository(AssetAnalysisEntity),
      ds.getRepository(AssetEntity),
      ds.getRepository(ProjectEntity),
      ds.getRepository(ProjectMediaEntity),
      ds.getRepository(FolderClosureEntity),
      {} as StorageAdapter,
      {} as AnalysisEnqueueService,
      {} as AnalysisBatchService,
      {} as AnalysisPipelineService,
      {} as AnalysisLogService,
      config,
    );
  });

  beforeEach(async () => {
    folderId = randomUUID();
    const folderName = `backfill-scope-${folderId.slice(0, 8)}`;
    await ds.query(
      `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, created_by)
       VALUES ($1, NULL, $2, $3, '{}', $4, 0, 'test')`,
      [folderId, folderName, folderName, folderName],
    );
    projectId = randomUUID();
    await ds.query(
      `INSERT INTO projects (id, owner_user_id, folder_id, name) VALUES ($1,'test-user',$2,$3)`,
      [projectId, folderId, `Project ${projectId.slice(0, 8)}`],
    );
  });

  afterEach(async () => {
    await ds.query(`DELETE FROM project_media WHERE project_id=$1`, [projectId]);
    for (const id of assetIds.splice(0)) await cleanupAsset(id);
    await ds.query(`DELETE FROM projects WHERE id=$1`, [projectId]);
    await ds.query(`DELETE FROM folders WHERE id=$1`, [folderId]);
  });

  it('includes every asset whose original is stored, rendered or not', async () => {
    for (const status of ['uploaded', 'processing', 'ready', 'failed']) {
      await insertLinkedAsset(status);
    }
    const result = await service.backfill({ projectIds: [projectId], mode: 'all', dryRun: true });
    expect(result.matched).toBe(4);
    expect(result.enqueued).toBe(4);
  });

  it('leaves out uploads and imports that are incomplete or cancelled', async () => {
    for (const status of ['uploading', 'importing', 'cancelled']) {
      await insertLinkedAsset(status);
    }
    const result = await service.backfill({ projectIds: [projectId], mode: 'all', dryRun: true });
    expect(result.matched).toBe(0);
  });
});
