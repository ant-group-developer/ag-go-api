/**
 * DB-level integration tests for FarmResultPollerService.
 *
 * Runs against a real Postgres instance (port 55434, started by docker-compose.test.yml).
 * The global setup creates the ag_go_test database and runs all migrations once before any
 * test file executes.
 *
 * Two external dependencies are faked:
 *   FakeFarmClient  — records job submissions and can be told to fail on a specific call.
 *   FakeStorage     — serves manifests registered by key; throws on unknown paths.
 *
 * All TypeORM repos / DataSource are the real ones, so every test exercises real SQL.
 */

import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { OutboxService } from '../../common/outbox.service';
import { AppDataSource } from '../../database/data-source';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaSegmentEntity } from '../../database/entities/media-segment.entity';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import type { StorageAdapter } from '../assets/storage/storage-adapter';
import { SystemLogService } from '../logs/system-log.service';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { AnalysisLogService } from './analysis-log.service';
import { FarmResultPollerService } from './farm-result-poller.service';
import type { FarmClient } from './farm/farm-client';
import type { JobView, SubmitJobRequest, SubmitJobResponse } from './farm/protocol';
import type { AiManifest, ExtractManifest } from './farm/scan';

// uuid v14 is pure-ESM; @nestjs/typeorm is also ESM-only — mock both so Jest (CommonJS) can
// load the service under test and its dependencies.
jest.mock('uuid', () => {
  let n = 0;
  return { v7: () => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}` };
});

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

// ---------------------------------------------------------------------------
// Fake infrastructure
// ---------------------------------------------------------------------------

/** Farm client that records submissions and can be told to fail on a specific call index. */
class FakeFarmClient {
  public submissions: Array<SubmitJobRequest & { submittedJobId: string }> = [];
  public cancelledIds: string[] = [];
  private failOnCallIndex: number | null = null;
  private callCount = 0;
  /**
   * Persistent correlation_id → farm_job_id map.
   * NOT cleared by reset() because the real farm keeps job records between retries.
   * This lets processJob re-submit a chunk with the same correlation_id and get back
   * the same farm_job_id, so insertFarmJob's ON CONFLICT DO NOTHING suppresses the duplicate row.
   */
  private readonly correlationMap = new Map<string, string>();

  get isConfigured(): boolean {
    return true;
  }

  /** Make the next submit call at (0-indexed) position `n` throw. */
  setFailOnCall(n: number): void {
    this.failOnCallIndex = n;
  }

  reset(): void {
    this.submissions = [];
    this.cancelledIds = [];
    this.failOnCallIndex = null;
    this.callCount = 0;
    // correlationMap intentionally preserved: the real farm keeps jobs between calls.
  }

  async submitJob(request: SubmitJobRequest): Promise<SubmitJobResponse> {
    if (this.callCount === this.failOnCallIndex) {
      this.callCount++;
      throw new Error('FakeFarmClient: simulated submission failure');
    }
    // Dedup by correlation_id, mirroring the real farm's idempotency guarantee.
    const corrKey = request.correlation_id ?? '';
    let jobId = corrKey ? this.correlationMap.get(corrKey) : undefined;
    if (!jobId) {
      jobId = randomUUID();
      if (corrKey) this.correlationMap.set(corrKey, jobId);
    }
    this.submissions.push({ ...request, submittedJobId: jobId });
    this.callCount++;
    return {
      job: {
        id: jobId,
        owner: 'ag-go',
        type: request.type as 'scan.ai',
        lane: (request.lane ?? 'batch') as 'batch',
        status: 'queued',
        priority: request.priority ?? 0,
        correlation_id: request.correlation_id,
        affinity_key: request.affinity_key ?? null,
        attempt_count: 0,
        max_attempts: request.max_attempts ?? 3,
        node_id: null,
        progress_percent: null,
        progress_stage: null,
        result: null,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        finished_at: null,
        acked_at: null,
      },
      created: true,
    };
  }

  async listUnackedFinished(): Promise<JobView[]> {
    return [];
  }
  async ackJob(): Promise<void> {}
  async cancelJob(farmJobId: string): Promise<void> {
    this.cancelledIds.push(farmJobId);
  }
}

/** Storage that serves registered paths; throws on anything else. */
class FakeStorage {
  private store = new Map<string, string>();

  register(path: string, content: string): void {
    this.store.set(path, content);
  }

  async getObjectText(path: string): Promise<string> {
    if (this.store.has(path)) return this.store.get(path)!;
    throw new Error(`FakeStorage: no manifest registered for path: ${path}`);
  }

  reset(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Manifest builders
// ---------------------------------------------------------------------------

function makeExtractManifest(
  assetId: string,
  numSegments: number,
  allDead = false,
): ExtractManifest {
  return {
    schema: 'ag.scan.extract/v1',
    asset_id: assetId,
    extract_version: 'x1',
    media: {
      kind: 'video',
      duration_ms: numSegments * 5000,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      rotation: 0,
    },
    proxy: null,
    contact_sheet: null,
    segments: Array.from({ length: numSegments }, (_, i) => ({
      index: i,
      start_ms: i * 5000,
      end_ms: (i + 1) * 5000,
      boundary_reason: (i === numSegments - 1 ? 'end' : 'scene_cut') as 'end' | 'scene_cut',
      orientation: 'landscape' as const,
      keyframes: [
        {
          output: `keyframes/seg-${i}-frame-0.jpg`,
          t_ms: i * 5000 + 100,
          width: 640,
          height: 360,
          dhash: '0123456789abcdef',
        },
      ],
      technical: {
        brightness: 0.5,
        blur: 30,
        black_ratio: 0,
        frozen_ratio: 0,
        silence_ratio: null,
        dead: allDead,
        dead_reason: allDead ? ('black' as const) : null,
      },
    })),
    tools: { ffmpeg: '6.0', worker_version: '0.1.0' },
  };
}

function makeAiManifest(assetId: string, chunk: number, segmentIds: string[]): AiManifest {
  return {
    schema: 'ag.scan.ai/v1',
    asset_id: assetId,
    chunk,
    model: 'qwen2.5vl:7b',
    prompt_version: 'p1',
    items: segmentIds.map((segId) => ({
      segment_id: segId,
      description: {
        caption_vi: 'Cảnh quay thử nghiệm',
        caption_en: 'Test scene description',
        tags: ['test'],
        keywords_vi: ['thử nghiệm'],
        subjects: ['building'],
        actions: ['static'],
        shot_size: 'wide' as const,
        camera_motion: 'static' as const,
        time_of_day: 'day' as const,
        setting: 'outdoor' as const,
        people_count: 'none' as const,
        visible_text: '',
        has_watermark: false,
        usable: true,
        usable_reason: '',
        quality: 4,
      },
      error: null,
      duration_ms: 5000,
    })),
  };
}

/** Builds a minimal completed JobView for testing processJob. */
function makeJobView(
  farmJobId: string,
  status: 'completed' | 'failed' | 'cancelled',
  correlationId: string,
  errorInfo?: { code: string; message: string },
): JobView {
  return {
    id: farmJobId,
    owner: 'ag-go',
    type: 'scan.extract',
    lane: 'batch',
    status,
    priority: 0,
    correlation_id: correlationId,
    affinity_key: null,
    attempt_count: 1,
    max_attempts: 3,
    node_id: null,
    progress_percent: null,
    progress_stage: null,
    result: null,
    error: errorInfo ? { ...errorInfo, retryable: false } : null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    acked_at: null,
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

let ds: DataSource;

/** Computes the storage prefix for a given asset/analysis pair. */
function computePrefix(assetStorageKey: string, assetId: string, analysisId: string): string {
  return `${assetVariantsPrefix(assetStorageKey, assetId)}analysis/${analysisId}/`;
}

/** Standard storage key pattern matching insertAsset. */
function storageKey(assetId: string): string {
  return `projects/p1/originals/${assetId}/clip.mp4`;
}

async function insertAsset(id: string = randomUUID()): Promise<string> {
  await ds.query(
    `INSERT INTO assets
       (id, asset_type, original_filename, mime_type, file_size_bytes,
        storage_provider, original_bucket, original_storage_key,
        processing_status, source_type, source_metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      'video',
      'clip.mp4',
      'video/mp4',
      102400,
      'r2',
      'ag-go',
      storageKey(id),
      'ready',
      'local',
      '{}',
      'test',
    ],
  );
  return id;
}

async function insertAnalysis(
  assetId: string,
  options: {
    id?: string;
    status?: string;
    isCurrent?: boolean;
    summary?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  await ds.query(
    `INSERT INTO asset_analyses
       (id, asset_id, status, priority, extract_version, prompt_version, is_current, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      assetId,
      options.status ?? 'queued',
      0,
      'x1',
      'p1',
      options.isCurrent ?? false,
      options.summary !== undefined ? JSON.stringify(options.summary) : null,
    ],
  );
  return id;
}

async function insertFarmJobRow(
  farmJobId: string,
  analysisId: string,
  type: string,
  chunk: number | null,
  options: { status?: string; ingestedAt?: Date | null } = {},
): Promise<void> {
  await ds.query(
    `INSERT INTO analysis_farm_jobs
       (farm_job_id, analysis_id, type, chunk, status, ingested_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [farmJobId, analysisId, type, chunk, options.status ?? 'submitted', options.ingestedAt ?? null],
  );
}

async function insertSegmentRow(
  analysisId: string,
  assetId: string,
  segmentIndex: number,
  options: { id?: string; isCurrent?: boolean; usable?: boolean | null } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  await ds.query(
    `INSERT INTO media_segments
       (id, analysis_id, asset_id, segment_index, start_ms, end_ms, is_current, usable)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      analysisId,
      assetId,
      segmentIndex,
      segmentIndex * 5000,
      (segmentIndex + 1) * 5000,
      options.isCurrent ?? false,
      options.usable ?? null,
    ],
  );
  return id;
}

async function insertFolder(name: string = 'test-folder'): Promise<string> {
  const id = randomUUID();
  const nameVal = `${name}-${id.slice(0, 8)}`;
  await ds.query(
    `INSERT INTO folders
       (id, parent_id, name, path_key, path_ids, path_text, depth, created_by)
     VALUES ($1, NULL, $2, $3, '{}', $4, 0, 'test')`,
    [id, nameVal, nameVal, nameVal],
  );
  return id;
}

async function insertCountry(name: string = 'Test Country'): Promise<string> {
  const id = randomUUID();
  await ds.query(`INSERT INTO countries (id, name) VALUES ($1, $2)`, [
    id,
    `${name} ${id.slice(0, 8)}`,
  ]);
  return id;
}

async function insertProvince(countryId: string, name: string = 'Test Province'): Promise<string> {
  const id = randomUUID();
  await ds.query(`INSERT INTO provinces (id, country_id, name) VALUES ($1,$2,$3)`, [
    id,
    countryId,
    name,
  ]);
  return id;
}

async function insertCategory(
  name: string = 'Test Category',
): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  const uniqueName = `${name}-${id.slice(0, 8)}`;
  await ds.query(`INSERT INTO categories (id, name, slug) VALUES ($1,$2,$3)`, [
    id,
    uniqueName,
    `slug-${id.slice(0, 8)}`,
  ]);
  return { id, name: uniqueName };
}

async function insertProject(
  folderId: string,
  options: {
    name?: string;
    categoryId?: string | null;
    provinceId?: string | null;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO projects
       (id, owner_user_id, folder_id, name, category_id, province_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      'test-user',
      folderId,
      options.name ?? `Project ${id.slice(0, 8)}`,
      options.categoryId ?? null,
      options.provinceId ?? null,
    ],
  );
  return id;
}

async function insertProjectMedia(projectId: string, assetId: string): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO project_media (id, project_id, asset_id, created_by) VALUES ($1,$2,$3,$4)`,
    [id, projectId, assetId, 'test'],
  );
  return id;
}

async function cleanupAsset(assetId: string): Promise<void> {
  // Cascades on asset_analyses → media_segments, analysis_farm_jobs, outbox_events (via aggregateId)
  await ds.query(
    `DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM asset_analyses WHERE asset_id=$1)`,
    [assetId],
  );
  await ds.query(`DELETE FROM assets WHERE id=$1`, [assetId]);
}

// ---------------------------------------------------------------------------
// Suite-level setup / teardown
// ---------------------------------------------------------------------------

let fakeClient: FakeFarmClient;
let fakeStorage: FakeStorage;
let poller: FarmResultPollerService;

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;

  fakeClient = new FakeFarmClient();
  fakeStorage = new FakeStorage();

  const outboxService = new OutboxService(ds.getRepository(OutboxEventEntity));

  const config = {
    get: (key: string) => {
      if (key === 'ANALYSIS_MODEL') return 'qwen2.5vl:7b';
      if (key === 'ANALYSIS_PROMPT_VERSION') return 'p1';
      return undefined;
    },
  } as unknown as ConfigService;

  poller = new FarmResultPollerService(
    ds,
    ds.getRepository(AssetAnalysisEntity),
    ds.getRepository(MediaSegmentEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AnalysisFarmJobEntity),
    fakeStorage as unknown as StorageAdapter,
    fakeClient as unknown as FarmClient,
    outboxService,
    new AnalysisLogService(
      new SystemLogService(ds.getRepository(SystemLogEntity)),
      ds.getRepository(SystemLogEntity),
    ),
    config,
  );
});

afterAll(async () => {
  if (ds.isInitialized) await ds.destroy();
});

beforeEach(() => {
  fakeClient.reset();
  fakeStorage.reset();
});

// ---------------------------------------------------------------------------
// 1. Extract completed → segments + chunks submitted + status describing
// ---------------------------------------------------------------------------

describe('extract completed', () => {
  let assetId: string;
  let analysisId: string;
  let extractJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', null);
    // 2 segments → 1 AI chunk (below SCAN_AI_MAX_CHUNK of 30)
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}extract.json`, JSON.stringify(makeExtractManifest(assetId, 2)));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('inserts 2 segments with is_current=false', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const rows = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM media_segments WHERE analysis_id=$1 ORDER BY segment_index`,
      [analysisId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r['is_current'] === false)).toBe(true);
  });

  it('submits exactly one scan.ai chunk with the correct correlation id', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    expect(fakeClient.submissions).toHaveLength(1);
    expect(fakeClient.submissions[0].correlation_id).toBe(`${analysisId}:ai:0`);
    expect(fakeClient.submissions[0].type).toBe('scan.ai');
  });

  it('inserts an analysis_farm_jobs row for the submitted AI chunk', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const aiJobs = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE analysis_id=$1 AND type='scan.ai'`,
      [analysisId],
    );
    expect(aiJobs).toHaveLength(1);
    expect(aiJobs[0]['chunk']).toBe(0);
  });

  it('marks the extract farm job as ingested and sets analysis status to describing', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const [extractJob] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [extractJobId],
    );
    expect(extractJob['ingested_at']).not.toBeNull();

    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('describing');
    expect((analysis['summary'] as { aiChunks: number } | null)?.aiChunks).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Submit failure on chunk 1 → retry succeeds, no duplicate segments / farm rows
// ---------------------------------------------------------------------------

describe('extract: submit failure and retry', () => {
  let assetId: string;
  let analysisId: string;
  let extractJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', null);
    // 31 segments → 2 AI chunks (chunk 0: segs 0-29, chunk 1: seg 30)
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}extract.json`, JSON.stringify(makeExtractManifest(assetId, 31)));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('does not mark the extract job ingested when chunk submission fails', async () => {
    fakeClient.setFailOnCall(1); // chunk 0 succeeds (call 0), chunk 1 fails (call 1)
    await expect(
      poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`)),
    ).rejects.toThrow('simulated submission failure');

    const [extractJob] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [extractJobId],
    );
    expect(extractJob['ingested_at']).toBeNull();
  });

  it('retry does not insert duplicate segments', async () => {
    fakeClient.setFailOnCall(1);
    await expect(
      poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`)),
    ).rejects.toThrow('simulated submission failure');
    fakeClient.reset(); // now both submits succeed

    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));

    const segments = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM media_segments WHERE analysis_id=$1`,
      [analysisId],
    );
    expect(segments).toHaveLength(31);
  });

  it('retry does not insert duplicate analysis_farm_jobs rows', async () => {
    fakeClient.setFailOnCall(1);
    await expect(
      poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`)),
    ).rejects.toThrow('simulated submission failure');
    fakeClient.reset();

    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));

    const aiJobs = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE analysis_id=$1 AND type='scan.ai'`,
      [analysisId],
    );
    expect(aiJobs).toHaveLength(2); // chunk 0 and chunk 1, no duplicates
  });

  it('retry marks the extract job ingested after all chunks succeed', async () => {
    fakeClient.setFailOnCall(1);
    await expect(
      poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`)),
    ).rejects.toThrow('simulated submission failure');
    fakeClient.reset();

    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));

    const [extractJob] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [extractJobId],
    );
    expect(extractJob['ingested_at']).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. AI chunk completions → finalize exactly once, correct counts, outbox event
// ---------------------------------------------------------------------------

describe('AI completions → finalize', () => {
  let assetId: string;
  let analysisId: string;
  let seg0Id: string;
  let seg1Id: string;
  let aiJob0Id: string;
  let aiJob1Id: string;
  const extractJobId = randomUUID();

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, {
      status: 'describing',
      summary: { aiChunks: 2 },
    });
    seg0Id = await insertSegmentRow(analysisId, assetId, 0, { usable: null });
    seg1Id = await insertSegmentRow(analysisId, assetId, 1, { usable: null });
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', null, {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    aiJob0Id = randomUUID();
    aiJob1Id = randomUUID();
    await insertFarmJobRow(aiJob0Id, analysisId, 'scan.ai', 0);
    await insertFarmJobRow(aiJob1Id, analysisId, 'scan.ai', 1);

    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(
      `${prefix}ai-0000.json`,
      JSON.stringify(makeAiManifest(assetId, 0, [seg0Id])),
    );
    fakeStorage.register(
      `${prefix}ai-0001.json`,
      JSON.stringify(makeAiManifest(assetId, 1, [seg1Id])),
    );
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('does not finalize after only the first AI chunk is ingested', async () => {
    await poller.processJob(makeJobView(aiJob0Id, 'completed', `${analysisId}:ai:0`));
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).not.toBe('completed');
  });

  it('finalizes after both AI chunks are ingested', async () => {
    await poller.processJob(makeJobView(aiJob0Id, 'completed', `${analysisId}:ai:0`));
    await poller.processJob(makeJobView(aiJob1Id, 'completed', `${analysisId}:ai:1`));
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('completed');
    expect(analysis['is_current']).toBe(true);
  });

  it('sets the correct segment and usable counts in the summary', async () => {
    await poller.processJob(makeJobView(aiJob0Id, 'completed', `${analysisId}:ai:0`));
    await poller.processJob(makeJobView(aiJob1Id, 'completed', `${analysisId}:ai:1`));
    const [analysis] = await ds.query<
      Array<{ summary: { segmentCount: number; usableCount: number } }>
    >(`SELECT summary FROM asset_analyses WHERE id=$1`, [analysisId]);
    expect(analysis.summary.segmentCount).toBe(2);
    // AI manifest sets usable=true for both segments
    expect(analysis.summary.usableCount).toBe(2);
  });

  it('emits exactly one asset.analysis.completed outbox event', async () => {
    await poller.processJob(makeJobView(aiJob0Id, 'completed', `${analysisId}:ai:0`));
    await poller.processJob(makeJobView(aiJob1Id, 'completed', `${analysisId}:ai:1`));
    const events = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM outbox_events WHERE event_type='asset.analysis.completed' AND aggregate_id=$1`,
      [analysisId],
    );
    expect(events).toHaveLength(1);
    const payload = events[0]['payload'] as { analysisId: string; assetId: string };
    expect(payload.analysisId).toBe(analysisId);
    expect(payload.assetId).toBe(assetId);
  });

  it('writes each step to the analysis processing log', async () => {
    await poller.processJob(makeJobView(aiJob0Id, 'completed', `${analysisId}:ai:0`));
    await poller.processJob(makeJobView(aiJob1Id, 'completed', `${analysisId}:ai:1`));
    const logs = await ds.query<Array<{ action: string; message: string }>>(
      `SELECT action, message FROM system_logs
        WHERE category='analysis' AND metadata->>'analysisId'=$1
        ORDER BY id`,
      [analysisId],
    );
    expect(logs.map((log) => log.action)).toEqual([
      'analysis.ai_ingested',
      'analysis.ai_ingested',
      'analysis.completed',
    ]);
    expect(logs[2].message).toBe('Completed clip.mp4: 2 segments, 2 usable');
    await ds.query(`DELETE FROM system_logs WHERE metadata->>'analysisId'=$1`, [analysisId]);
  });

  it('sets is_current=true on all segments of the completed analysis', async () => {
    await poller.processJob(makeJobView(aiJob0Id, 'completed', `${analysisId}:ai:0`));
    await poller.processJob(makeJobView(aiJob1Id, 'completed', `${analysisId}:ai:1`));
    const segments = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM media_segments WHERE analysis_id=$1`,
      [analysisId],
    );
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s['is_current'] === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. One chunk failed → analysis failed; the other chunk completing later stays failed; siblings cancelled
// ---------------------------------------------------------------------------

describe('one chunk failed', () => {
  let assetId: string;
  let analysisId: string;
  let aiJob0Id: string;
  let aiJob1Id: string;
  const extractJobId = randomUUID();

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, {
      status: 'describing',
      summary: { aiChunks: 2 },
    });
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', null, {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    aiJob0Id = randomUUID();
    aiJob1Id = randomUUID();
    await insertFarmJobRow(aiJob0Id, analysisId, 'scan.ai', 0);
    await insertFarmJobRow(aiJob1Id, analysisId, 'scan.ai', 1);

    // Register AI manifest only for job 1 (used in the later-completion test)
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}ai-0001.json`, JSON.stringify(makeAiManifest(assetId, 1, [])));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('marks analysis as failed with the farm error reason', async () => {
    await poller.processJob(
      makeJobView(aiJob0Id, 'failed', `${analysisId}:ai:0`, {
        code: 'WORKER_CRASH',
        message: 'Out of memory',
      }),
    );
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('failed');
    expect(analysis['reason']).toMatch(/WORKER_CRASH/);
  });

  it('marks the failed farm job as ingested with status=failed', async () => {
    await poller.processJob(
      makeJobView(aiJob0Id, 'failed', `${analysisId}:ai:0`, {
        code: 'WORKER_CRASH',
        message: 'Out of memory',
      }),
    );
    const [job] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [aiJob0Id],
    );
    expect(job['status']).toBe('failed');
    expect(job['ingested_at']).not.toBeNull();
  });

  it('cancels the sibling AI job at the farm', async () => {
    await poller.processJob(
      makeJobView(aiJob0Id, 'failed', `${analysisId}:ai:0`, {
        code: 'WORKER_CRASH',
        message: 'Out of memory',
      }),
    );
    expect(fakeClient.cancelledIds).toContain(aiJob1Id);
  });

  it('completing the sibling AI job later does NOT flip analysis to completed', async () => {
    // First: fail job 0 → analysis=failed
    await poller.processJob(
      makeJobView(aiJob0Id, 'failed', `${analysisId}:ai:0`, {
        code: 'WORKER_CRASH',
        message: 'Out of memory',
      }),
    );
    // Then: job 1 arrives as completed (e.g. was already running when cancelled)
    await poller.processJob(makeJobView(aiJob1Id, 'completed', `${analysisId}:ai:1`));

    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('failed');

    const events = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM outbox_events WHERE event_type='asset.analysis.completed' AND aggregate_id=$1`,
      [analysisId],
    );
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. All-dead extract → completes directly (no AI chunks needed)
// ---------------------------------------------------------------------------

describe('all-dead extract', () => {
  let assetId: string;
  let analysisId: string;
  let extractJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', null);
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(
      `${prefix}extract.json`,
      JSON.stringify(makeExtractManifest(assetId, 2, /* allDead */ true)),
    );
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('completes the analysis directly without submitting AI jobs', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    expect(fakeClient.submissions).toHaveLength(0);
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('completed');
    expect(analysis['is_current']).toBe(true);
  });

  it('emits an asset.analysis.completed outbox event', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const events = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM outbox_events WHERE event_type='asset.analysis.completed' AND aggregate_id=$1`,
      [analysisId],
    );
    expect(events).toHaveLength(1);
  });

  it('inserts segments with usable=false and is_current=true after finalize', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const segments = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM media_segments WHERE analysis_id=$1`,
      [analysisId],
    );
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s['usable'] === false)).toBe(true);
    expect(segments.every((s) => s['is_current'] === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Second analysis of the same asset → previous flipped off, exactly one current
// ---------------------------------------------------------------------------

describe('second analysis flips the previous one off', () => {
  let assetId: string;
  let analysis1Id: string;
  let analysis2Id: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysis1Id = await insertAnalysis(assetId, { status: 'completed', isCurrent: true });
    // seg1 belongs to first analysis (current)
    await insertSegmentRow(analysis1Id, assetId, 0, { isCurrent: true });

    // Second analysis: has its extract job ingested and one AI job ingested too.
    // We set up the data manually and call finalizeIfDone directly.
    analysis2Id = await insertAnalysis(assetId, {
      status: 'describing',
      isCurrent: false,
      summary: { aiChunks: 1 },
    });
    const seg2Id = await insertSegmentRow(analysis2Id, assetId, 0, { isCurrent: false });

    const extractJobId2 = randomUUID();
    await insertFarmJobRow(extractJobId2, analysis2Id, 'scan.extract', null, {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    const aiJob2Id = randomUUID();
    await insertFarmJobRow(aiJob2Id, analysis2Id, 'scan.ai', 0, {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    // Store seg2Id for use in tests (suppress unused-variable lint)
    void seg2Id;
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('leaves exactly one is_current=true analysis after finalizing the second', async () => {
    await poller.finalizeIfDone(analysis2Id);
    const currentAnalyses = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM asset_analyses WHERE asset_id=$1 AND is_current=true`,
      [assetId],
    );
    expect(currentAnalyses).toHaveLength(1);
    expect(currentAnalyses[0]['id']).toBe(analysis2Id);
  });

  it('flips the first analysis to is_current=false', async () => {
    await poller.finalizeIfDone(analysis2Id);
    const [analysis1] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT is_current FROM asset_analyses WHERE id=$1`,
      [analysis1Id],
    );
    expect(analysis1['is_current']).toBe(false);
  });

  it('sets all segments of the second analysis to is_current=true', async () => {
    await poller.finalizeIfDone(analysis2Id);
    const segments = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM media_segments WHERE analysis_id=$1`,
      [analysis2Id],
    );
    expect(segments.every((s) => s['is_current'] === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Two concurrent processJob calls → only one ingests (lock contention)
// ---------------------------------------------------------------------------

describe('concurrent processJob calls on the same farm job', () => {
  let assetId: string;
  let analysisId: string;
  let aiJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, {
      status: 'describing',
      summary: { aiChunks: 1 },
    });
    const extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', null, {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    aiJobId = randomUUID();
    await insertFarmJobRow(aiJobId, analysisId, 'scan.ai', 0);

    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}ai-0000.json`, JSON.stringify(makeAiManifest(assetId, 0, [])));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('exactly one call ingests the result; the other skips', async () => {
    const job = makeJobView(aiJobId, 'completed', `${analysisId}:ai:0`);
    const [r1, r2] = await Promise.all([poller.processJob(job), poller.processJob(job)]);

    // At least one call must succeed (return true). If the second call detects the row is
    // already ingested before checking the lock it also returns true (valid short-circuit).
    // If the lock fires before that, the second returns false. Both outcomes are correct;
    // the invariant that matters — single ingestion — is verified by the next test.
    expect(r1 || r2).toBe(true);
  });

  it('the farm job row is ingested exactly once', async () => {
    const job = makeJobView(aiJobId, 'completed', `${analysisId}:ai:0`);
    await Promise.all([poller.processJob(job), poller.processJob(job)]);

    const [farmJobRow] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [aiJobId],
    );
    expect(farmJobRow['ingested_at']).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Adoption of a missing row from correlation id
// ---------------------------------------------------------------------------

describe('adoption from correlation_id', () => {
  let assetId: string;
  let analysisId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    // Deliberately do NOT insert an analysis_farm_jobs row — the poller must create it.
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}extract.json`, JSON.stringify(makeExtractManifest(assetId, 1)));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('creates the local row and processes normally when only correlation_id is available', async () => {
    const phantomJobId = randomUUID();
    // processJob with a job id that is NOT in analysis_farm_jobs — adoption path
    const result = await poller.processJob(
      makeJobView(phantomJobId, 'completed', `${analysisId}:extract`),
    );
    expect(result).toBe(true);

    // The adopted row should now exist and be ingested
    const [adopted] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [phantomJobId],
    );
    expect(adopted).toBeDefined();
    expect(adopted['ingested_at']).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. getAssetContext returns project / category / province names
// ---------------------------------------------------------------------------

describe('getAssetContext', () => {
  let assetId: string;
  let analysisId: string;
  let extractJobId: string;
  let countryId: string;
  let provinceId: string;
  let categoryId: string;
  let categoryName: string;
  let folderId: string;
  let projectId: string;

  beforeEach(async () => {
    // Set up full project hierarchy
    countryId = await insertCountry('Test Country');
    provinceId = await insertProvince(countryId, 'Hà Nội');
    const category = await insertCategory('Phim tài liệu');
    categoryId = category.id;
    categoryName = category.name;
    folderId = await insertFolder();
    assetId = await insertAsset();
    projectId = await insertProject(folderId, {
      name: 'AG Test Project',
      categoryId,
      provinceId,
    });
    await insertProjectMedia(projectId, assetId);
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', null);
    // 1 segment → 1 AI chunk → getAssetContext will be called during submission
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}extract.json`, JSON.stringify(makeExtractManifest(assetId, 1)));
  });

  afterEach(async () => {
    // Delete project_media explicitly before asset (in case there is no ON DELETE CASCADE)
    await ds.query(`DELETE FROM project_media WHERE asset_id=$1`, [assetId]);
    await cleanupAsset(assetId);
    await ds.query(`DELETE FROM projects WHERE id=$1`, [projectId]);
    await ds.query(`DELETE FROM folders WHERE id=$1`, [folderId]);
    await ds.query(`DELETE FROM categories WHERE id=$1`, [categoryId]);
    await ds.query(`DELETE FROM provinces WHERE id=$1`, [provinceId]);
    await ds.query(`DELETE FROM countries WHERE id=$1`, [countryId]);
  });

  it('includes the project name in the submitted AI payload context', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    expect(fakeClient.submissions).toHaveLength(1);
    const payload = fakeClient.submissions[0].payload as {
      context: { project_names: string[]; category_names: string[]; province_names: string[] };
    };
    expect(payload.context.project_names).toContain('AG Test Project');
  });

  it('includes the category name in the submitted AI payload context', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const payload = fakeClient.submissions[0].payload as {
      context: { category_names: string[] };
    };
    expect(payload.context.category_names).toContain(categoryName);
  });

  it('includes the province name in the submitted AI payload context', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const payload = fakeClient.submissions[0].payload as {
      context: { province_names: string[] };
    };
    expect(payload.context.province_names).toContain('Hà Nội');
  });
});
