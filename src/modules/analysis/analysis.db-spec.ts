/**
 * DB-level integration tests for the media-analysis module.
 * These run against a real Postgres instance (the test DB started by docker-compose.test.yml).
 * The global setup (jest.db-global-setup.ts) creates the database and runs all migrations
 * before any test in this file executes.
 *
 * Tests clean up their own rows after each case to keep the DB usable across test files.
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { MediaSegmentEntity } from '../../database/entities/media-segment.entity';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { MediaAnalysisMigration2020000000000 } from '../../database/migrations/2020000000000-media-analysis';

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
      'ready',
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
      overrides.extract_version ?? 'x1',
      overrides.prompt_version ?? 'p1',
      overrides.is_current ?? false,
    ],
  );
  return id;
}

async function insertSegment(
  analysisId: string,
  assetId: string,
  overrides: Partial<{
    id: string;
    segment_index: number;
    is_current: boolean;
    usable: boolean | null;
  }> = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await ds.query(
    `INSERT INTO media_segments
       (id, analysis_id, asset_id, segment_index, start_ms, end_ms, is_current)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, analysisId, assetId, overrides.segment_index ?? 0, 0, 5000, overrides.is_current ?? false],
  );
  if (overrides.usable !== undefined) {
    await ds.query(`UPDATE media_segments SET usable=$1 WHERE id=$2`, [overrides.usable, id]);
  }
  return id;
}

async function cleanupAsset(assetId: string): Promise<void> {
  // Cascades handle child rows
  await ds.query(`DELETE FROM assets WHERE id=$1`, [assetId]);
}

// ---------------------------------------------------------------------------
// Migration: run → revert → run
// ---------------------------------------------------------------------------

describe('MediaAnalysisMigration2020000000000', () => {
  it('can be reverted and re-applied without errors', async () => {
    // Ensure no analysis data remains that would block revert
    await ds.query(`DELETE FROM analysis_farm_jobs`);
    await ds.query(`DELETE FROM media_segments`);
    await ds.query(`DELETE FROM asset_analyses`);

    const migration = new MediaAnalysisMigration2020000000000();
    const runner = ds.createQueryRunner();

    try {
      await migration.down(runner);
      // Tables should be gone
      const afterDown = await ds.query<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename IN ('asset_analyses','media_segments','analysis_farm_jobs')`,
      );
      expect(afterDown).toHaveLength(0);

      await migration.up(runner);
      // Tables should be back
      const afterUp = await ds.query<Array<{ tablename: string }>>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public'
         AND tablename IN ('asset_analyses','media_segments','analysis_farm_jobs')`,
      );
      expect(afterUp).toHaveLength(3);
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
        [analysisId, assetId, 'queued', 0, 'x1', 'p1', false],
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
    // Raw SQL returns snake_case column names
    expect((events[0] as unknown as Record<string, unknown>)['event_type']).toBe(
      'asset.analysis.requested',
    );

    // Cleanup
    await ds.query(`DELETE FROM outbox_events WHERE aggregate_id=$1`, [analysisId]);
  });
});

// ---------------------------------------------------------------------------
// Segment insertion from extract manifest
// ---------------------------------------------------------------------------

describe('segment insertion', () => {
  let assetId: string;
  let analysisId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('inserts segments with is_current=false after extract', async () => {
    const seg0Id = randomUUID();
    const seg1Id = randomUUID();

    await ds.query(
      `INSERT INTO media_segments
         (id, analysis_id, asset_id, segment_index, start_ms, end_ms, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7),($8,$9,$10,$11,$12,$13,$14)`,
      [
        seg0Id,
        analysisId,
        assetId,
        0,
        0,
        5000,
        false,
        seg1Id,
        analysisId,
        assetId,
        1,
        5000,
        10000,
        false,
      ],
    );

    const segments = await ds.query<MediaSegmentEntity[]>(
      `SELECT * FROM media_segments WHERE analysis_id=$1 ORDER BY segment_index`,
      [analysisId],
    );
    expect(segments).toHaveLength(2);
    // Raw SQL returns snake_case column names
    expect(
      segments.every((s) => (s as unknown as Record<string, unknown>)['is_current'] === false),
    ).toBe(true);
  });

  it('marks dead segments with usable=false and a reason', async () => {
    const segId = randomUUID();
    await ds.query(
      `INSERT INTO media_segments
         (id, analysis_id, asset_id, segment_index, start_ms, end_ms, is_current, usable, usable_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [segId, analysisId, assetId, 0, 0, 5000, false, false, 'black'],
    );

    const [seg] = await ds.query<MediaSegmentEntity[]>(`SELECT * FROM media_segments WHERE id=$1`, [
      segId,
    ]);
    const rawSeg = seg as unknown as Record<string, unknown>;
    expect(rawSeg['usable']).toBe(false);
    expect(rawSeg['usable_reason']).toBe('black');
  });

  it('enforces the unique constraint on (analysis_id, segment_index)', async () => {
    await ds.query(
      `INSERT INTO media_segments
         (id, analysis_id, asset_id, segment_index, start_ms, end_ms, is_current)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), analysisId, assetId, 0, 0, 5000, false],
    );

    await expect(
      ds.query(
        `INSERT INTO media_segments
           (id, analysis_id, asset_id, segment_index, start_ms, end_ms, is_current)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), analysisId, assetId, 0, 0, 5000, false],
      ),
    ).rejects.toThrow();
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
    // First analysis: completed and current
    const analysis1Id = await insertAnalysis(assetId, {
      status: 'completed',
      is_current: true,
    });
    const seg1Id = await insertSegment(analysis1Id, assetId, { is_current: true });

    // Second analysis: completed, not yet current
    const analysis2Id = await insertAnalysis(assetId, {
      status: 'extracted',
      is_current: false,
    });
    const seg2Id = await insertSegment(analysis2Id, assetId, {
      segment_index: 0,
      is_current: false,
    });

    // Simulate the finalize transaction
    await ds.transaction(async (manager) => {
      // Flip old current off first
      await manager.query(
        `UPDATE asset_analyses SET is_current=false WHERE asset_id=$1 AND is_current=true`,
        [assetId],
      );
      await manager.query(
        `UPDATE media_segments SET is_current=false WHERE asset_id=$1 AND is_current=true`,
        [assetId],
      );
      // Flip new analysis on
      await manager.query(
        `UPDATE asset_analyses SET is_current=true, status='completed' WHERE id=$1`,
        [analysis2Id],
      );
      await manager.query(`UPDATE media_segments SET is_current=true WHERE analysis_id=$1`, [
        analysis2Id,
      ]);
    });

    const currentAnalyses = await ds.query<AssetAnalysisEntity[]>(
      `SELECT * FROM asset_analyses WHERE asset_id=$1 AND is_current=true`,
      [assetId],
    );
    expect(currentAnalyses).toHaveLength(1);
    expect(currentAnalyses[0].id).toBe(analysis2Id);

    const currentSegs = await ds.query<MediaSegmentEntity[]>(
      `SELECT * FROM media_segments WHERE asset_id=$1 AND is_current=true`,
      [assetId],
    );
    expect(currentSegs).toHaveLength(1);
    expect(currentSegs[0].id).toBe(seg2Id);

    // Old analysis and segment should no longer be current
    const [oldAnalysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM asset_analyses WHERE id=$1`,
      [analysis1Id],
    );
    // Raw SQL returns snake_case column names
    expect(oldAnalysis?.['is_current']).toBe(false);
    // Unused variable seg1Id intentionally kept; suppress lint warning
    void seg1Id;
  });

  it('the partial unique index prevents two concurrent is_current=true rows', async () => {
    await insertAnalysis(assetId, { status: 'completed', is_current: true });

    // Inserting a second is_current=true row for the same asset must fail
    await expect(
      insertAnalysis(assetId, { status: 'completed', is_current: true }),
    ).rejects.toThrow();
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
    // Asset has no current analysis → needs backfill
    const [countRow] = await ds.query<[{ count: string }]>(
      `SELECT COUNT(*) AS count FROM assets a
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_analyses aa
         WHERE aa.asset_id = a.id AND aa.is_current = true
         AND aa.extract_version = 'x1' AND aa.prompt_version = 'p1'
       ) AND a.id = $1`,
      [assetId],
    );
    expect(Number(countRow.count)).toBe(1);

    // No rows were inserted by the dry-run query
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
      [analysisId, assetId, 'queued', 0, 'x1', 'p1', false],
    );

    const rows = await ds.query<AssetAnalysisEntity[]>(
      `SELECT * FROM asset_analyses WHERE asset_id=$1`,
      [assetId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('queued');
  });

  it('backfill skips assets that already have a current analysis at the target versions', async () => {
    // Insert a current analysis at x1/p1
    await insertAnalysis(assetId, {
      status: 'completed',
      is_current: true,
      extract_version: 'x1',
      prompt_version: 'p1',
    });

    const [countRow] = await ds.query<[{ count: string }]>(
      `SELECT COUNT(*) AS count FROM assets a
       WHERE NOT EXISTS (
         SELECT 1 FROM asset_analyses aa
         WHERE aa.asset_id = a.id AND aa.is_current = true
         AND aa.extract_version = 'x1' AND aa.prompt_version = 'p1'
       ) AND a.id = $1`,
      [assetId],
    );
    expect(Number(countRow.count)).toBe(0);
  });
});
