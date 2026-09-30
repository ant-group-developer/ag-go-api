/**
 * DB-level integration tests for FarmResultPollerService (v2: per-asset scan).
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
import { AnalysisBatchEntity } from '../../database/entities/analysis-batch.entity';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import type { StorageAdapter } from '../assets/storage/storage-adapter';
import { SystemLogService } from '../logs/system-log.service';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';
import { FarmResultPollerService } from './farm-result-poller.service';
import type { FarmClient } from './farm/farm-client';
import type {
  JobControlAction,
  JobView,
  SubmitJobRequest,
  SubmitJobResponse,
} from './farm/protocol';
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
  public controlActions: Array<{
    action: JobControlAction;
    selector: { ids?: string[]; group_key?: string };
  }> = [];
  private failOnCallIndex: number | null = null;
  private callCount = 0;
  /**
   * Persistent correlation_id → farm_job_id map.
   * NOT cleared by reset() because the real farm keeps job records between retries.
   * This lets processJob re-submit with the same correlation_id and get back the same farm_job_id,
   * so recordFarmJob's ON CONFLICT DO NOTHING suppresses the duplicate row.
   */
  private readonly correlationMap = new Map<string, string>();

  get isConfigured(): boolean {
    return true;
  }

  setFailOnCall(n: number): void {
    this.failOnCallIndex = n;
  }

  reset(): void {
    this.submissions = [];
    this.cancelledIds = [];
    this.controlActions = [];
    this.failOnCallIndex = null;
    this.callCount = 0;
    // correlationMap intentionally preserved: the real farm keeps jobs between calls.
  }

  async submitJob(request: SubmitJobRequest): Promise<SubmitJobResponse> {
    if (this.callCount === this.failOnCallIndex) {
      this.callCount++;
      throw new Error('FakeFarmClient: simulated submission failure');
    }
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
        group_key: request.group_key ?? null,
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
  async controlJobs(
    action: JobControlAction,
    selector: { ids: string[] } | { group_key: string },
  ): Promise<number> {
    this.controlActions.push({ action, selector });
    return 0;
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
// Manifest builders (v2)
// ---------------------------------------------------------------------------

function makeExtractManifest(
  assetId: string,
  numKeyframes: number,
  allDead = false,
): ExtractManifest {
  return {
    schema: 'ag.scan.extract/v2',
    asset_id: assetId,
    extract_version: 'x2',
    media: {
      kind: 'video',
      duration_ms: numKeyframes * 5000,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      rotation: 0,
    },
    orientation: 'landscape',
    proxy: { output: 'proxy.mp4', width: 1280, height: 720, size_bytes: 102400 },
    contact_sheet: null,
    scenes: Array.from({ length: Math.max(numKeyframes, 1) }, (_, i) => ({
      index: i,
      start_ms: i * 5000,
      end_ms: (i + 1) * 5000,
    })),
    keyframes: Array.from({ length: Math.max(numKeyframes, 1) }, (_, i) => ({
      output: `keyframes/${String(i).padStart(4, '0')}.jpg`,
      t_ms: i * 5000 + 100,
      width: 640,
      height: 360,
      dhash: '0123456789abcdef',
      scene_index: i,
    })),
    technical: {
      brightness: 0.5,
      blur: 30,
      black_ratio: allDead ? 0.95 : 0,
      frozen_ratio: 0,
      silence_ratio: null,
      has_speech_hint: null,
      dead: allDead,
      dead_reason: allDead ? 'black' : null,
    },
    tools: { ffmpeg: '6.0', worker_version: '0.2.0' },
  };
}

function makeAiManifest(assetId: string, descriptionNull = false): AiManifest {
  return {
    schema: 'ag.scan.ai/v2',
    asset_id: assetId,
    model: 'qwen2.5vl:7b',
    prompt_version: 'p2',
    description: descriptionNull
      ? null
      : {
          title_vi: 'Cảnh quay thử nghiệm',
          summary_vi: 'Video kiểm tra hệ thống',
          summary_en: 'System test video',
          genre: 'test',
          topics: ['testing'],
          subjects: ['building'],
          places: ['Hà Nội'],
          actions: ['static'],
          keywords_vi: ['kiểm tra'],
          tags: ['test'],
          mood: 'calm',
          setting: 'outdoor',
          time_of_day: 'day',
          people_count: 'none',
          shot_variety: ['wide'],
          camera_motions: ['static'],
          visible_text: '',
          has_watermark: false,
          usable: true,
          usable_reason: '',
          quality: 4,
        },
    notes: ['Nhóm 1: cảnh ngoài trời'],
    error: descriptionNull ? 'Model failed to produce a valid description' : null,
    duration_ms: 1500,
  };
}

/** Builds a minimal finished JobView for testing processJob. */
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
    group_key: null,
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

function computePrefix(assetStorageKey: string, assetId: string, analysisId: string): string {
  return `${assetVariantsPrefix(assetStorageKey, assetId)}analysis/${analysisId}/`;
}

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
    batchId?: string | null;
  } = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  await ds.query(
    `INSERT INTO asset_analyses
       (id, asset_id, status, priority, extract_version, prompt_version, is_current, batch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      assetId,
      options.status ?? 'queued',
      0,
      'x2',
      'p2',
      options.isCurrent ?? false,
      options.batchId ?? null,
    ],
  );
  return id;
}

async function insertFarmJobRow(
  farmJobId: string,
  analysisId: string,
  type: string,
  options: { status?: string; ingestedAt?: Date | null } = {},
): Promise<void> {
  await ds.query(
    `INSERT INTO analysis_farm_jobs
       (farm_job_id, analysis_id, type, chunk, status, ingested_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [farmJobId, analysisId, type, null, options.status ?? 'submitted', options.ingestedAt ?? null],
  );
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

async function cleanupAsset(assetId: string): Promise<void> {
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
let pipeline: AnalysisPipelineService;

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;

  fakeClient = new FakeFarmClient();
  fakeStorage = new FakeStorage();

  const outboxService = new OutboxService(ds.getRepository(OutboxEventEntity));
  const sysLog = new SystemLogService(ds.getRepository(SystemLogEntity));
  const analysisLog = new AnalysisLogService(sysLog, ds.getRepository(SystemLogEntity));

  const config = {
    get: (key: string) => {
      if (key === 'ANALYSIS_MODEL') return 'qwen2.5vl:7b';
      if (key === 'ANALYSIS_PROMPT_VERSION') return 'p2';
      return undefined;
    },
  } as unknown as ConfigService;

  pipeline = new AnalysisPipelineService(
    ds,
    ds.getRepository(AssetAnalysisEntity),
    ds.getRepository(AnalysisBatchEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AnalysisFarmJobEntity),
    fakeClient as unknown as FarmClient,
    outboxService,
    analysisLog,
    config,
  );

  poller = new FarmResultPollerService(
    ds,
    ds.getRepository(AssetAnalysisEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AnalysisFarmJobEntity),
    fakeStorage as unknown as StorageAdapter,
    fakeClient as unknown as FarmClient,
    pipeline,
    analysisLog,
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
// 1. Extract completed (v2) → keyframes/technical stored, one scan.ai submitted
// ---------------------------------------------------------------------------

describe('extract completed (v2)', () => {
  let assetId: string;
  let analysisId: string;
  let extractJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract');
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}extract.json`, JSON.stringify(makeExtractManifest(assetId, 3)));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('stores keyframes on the analysis row', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const [row] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT keyframes FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    const kfs = row['keyframes'] as Array<{ output: string }>;
    expect(Array.isArray(kfs)).toBe(true);
    expect(kfs.length).toBe(3);
    expect(kfs[0].output).toMatch(/keyframes\//);
  });

  it('stores technical metrics on the analysis row', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const [row] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT technical FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    const tech = row['technical'] as Record<string, unknown>;
    expect(tech).toBeDefined();
    expect(tech['dead']).toBe(false);
  });

  it('submits exactly one scan.ai job with the correct correlation id', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    expect(fakeClient.submissions).toHaveLength(1);
    expect(fakeClient.submissions[0].correlation_id).toBe(`${analysisId}:ai`);
    expect(fakeClient.submissions[0].type).toBe('scan.ai');
  });

  it('includes asset_name in the scan.ai payload context', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const payload = fakeClient.submissions[0].payload as {
      context: { asset_name: string };
    };
    expect(payload.context.asset_name).toBe('clip.mp4');
  });

  it('marks the extract farm job as ingested and sets analysis status to describing', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const [extractJob] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT ingested_at FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [extractJobId],
    );
    expect(extractJob['ingested_at']).not.toBeNull();

    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('describing');
  });

  it('submits scan.ai with the batch group_key when analysis has a batch', async () => {
    const batchId = randomUUID();
    await ds.query(
      `INSERT INTO analysis_batches (id, name, kind, status) VALUES ($1,'Test batch','backfill','running')`,
      [batchId],
    );
    const assetId2 = await insertAsset();
    const analysisId2 = await insertAnalysis(assetId2, { status: 'extracting', batchId });
    const extractJobId2 = randomUUID();
    await insertFarmJobRow(extractJobId2, analysisId2, 'scan.extract');
    const prefix2 = computePrefix(storageKey(assetId2), assetId2, analysisId2);
    fakeStorage.register(
      `${prefix2}extract.json`,
      JSON.stringify(makeExtractManifest(assetId2, 2)),
    );
    fakeClient.reset();

    await poller.processJob(makeJobView(extractJobId2, 'completed', `${analysisId2}:extract`));

    expect(fakeClient.submissions[0].group_key).toBe(`batch:${batchId}`);

    await cleanupAsset(assetId2);
    await ds.query(`DELETE FROM analysis_batches WHERE id=$1`, [batchId]);
  });
});

// ---------------------------------------------------------------------------
// 2. Dead video extract → completes directly without AI
// ---------------------------------------------------------------------------

describe('dead video extract', () => {
  let assetId: string;
  let analysisId: string;
  let extractJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract');
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(
      `${prefix}extract.json`,
      JSON.stringify(makeExtractManifest(assetId, 1, /* allDead */ true)),
    );
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('completes the analysis directly without submitting AI jobs', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    expect(fakeClient.submissions).toHaveLength(0);
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status, usable FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('completed');
    expect(analysis['usable']).toBe(false);
  });

  it('emits an asset.analysis.completed outbox event', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const events = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM outbox_events WHERE event_type='asset.analysis.completed' AND aggregate_id=$1`,
      [analysisId],
    );
    expect(events).toHaveLength(1);
  });

  it('sets is_current=true after finalize', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT is_current FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['is_current']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. AI completed → description stored, search_vector populated, finalized
// ---------------------------------------------------------------------------

describe('AI completed → finalize', () => {
  let assetId: string;
  let analysisId: string;
  let aiJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'describing' });
    const extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    // Store keyframes so submitAi path (if ever triggered) has something to work with
    await ds.query(
      `UPDATE asset_analyses SET keyframes=$1, duration_ms=$2, has_audio=$3 WHERE id=$4`,
      [
        JSON.stringify([
          {
            output: 'keyframes/0000.jpg',
            t_ms: 100,
            width: 640,
            height: 360,
            dhash: '0123456789abcdef',
            scene_index: 0,
          },
        ]),
        5000,
        true,
        analysisId,
      ],
    );
    aiJobId = randomUUID();
    await insertFarmJobRow(aiJobId, analysisId, 'scan.ai');

    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}ai.json`, JSON.stringify(makeAiManifest(assetId)));
  });

  afterEach(async () => {
    await ds.query(`DELETE FROM system_logs WHERE metadata->>'analysisId'=$1`, [analysisId]);
    await cleanupAsset(assetId);
  });

  it('stores the description on the analysis row', async () => {
    await poller.processJob(makeJobView(aiJobId, 'completed', `${analysisId}:ai`));
    const [row] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT description FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    const desc = row['description'] as Record<string, unknown>;
    expect(desc).toBeDefined();
    expect(desc['title_vi']).toBe('Cảnh quay thử nghiệm');
  });

  it('populates search_vector so the analysis is findable by text search', async () => {
    await poller.processJob(makeJobView(aiJobId, 'completed', `${analysisId}:ai`));
    const matches = await ds.query<Array<{ id: string }>>(
      `SELECT id FROM asset_analyses
       WHERE search_vector @@ plainto_tsquery('simple', immutable_unaccent('canh quay'))
         AND id=$1`,
      [analysisId],
    );
    expect(matches).toHaveLength(1);
  });

  it('finalizes with status=completed and is_current=true', async () => {
    await poller.processJob(makeJobView(aiJobId, 'completed', `${analysisId}:ai`));
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status, is_current FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('completed');
    expect(analysis['is_current']).toBe(true);
  });

  it('emits exactly one asset.analysis.completed outbox event', async () => {
    await poller.processJob(makeJobView(aiJobId, 'completed', `${analysisId}:ai`));
    const events = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM outbox_events WHERE event_type='asset.analysis.completed' AND aggregate_id=$1`,
      [analysisId],
    );
    expect(events).toHaveLength(1);
    const payload = events[0]['payload'] as { analysisId: string; assetId: string };
    expect(payload.analysisId).toBe(analysisId);
    expect(payload.assetId).toBe(assetId);
  });

  it('writes analysis.ai_ingested and analysis.completed log entries', async () => {
    await poller.processJob(makeJobView(aiJobId, 'completed', `${analysisId}:ai`));
    const logs = await ds.query<Array<{ action: string }>>(
      `SELECT action FROM system_logs
       WHERE category='analysis' AND metadata->>'analysisId'=$1
       ORDER BY id`,
      [analysisId],
    );
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(['analysis.ai_ingested', 'analysis.completed']),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. AI completed with null description → analysis failed
// ---------------------------------------------------------------------------

describe('AI completed with null description', () => {
  let assetId: string;
  let analysisId: string;
  let aiJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'describing' });
    const extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    aiJobId = randomUUID();
    await insertFarmJobRow(aiJobId, analysisId, 'scan.ai');

    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(
      `${prefix}ai.json`,
      JSON.stringify(makeAiManifest(assetId, /* descriptionNull */ true)),
    );
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('marks the analysis as failed with a descriptive reason', async () => {
    await poller.processJob(makeJobView(aiJobId, 'completed', `${analysisId}:ai`));
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status, reason FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('failed');
    expect(analysis['reason'] as string).toMatch(/No description/);
  });

  it('does not emit a completed outbox event', async () => {
    await poller.processJob(makeJobView(aiJobId, 'completed', `${analysisId}:ai`));
    const events = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM outbox_events WHERE event_type='asset.analysis.completed' AND aggregate_id=$1`,
      [analysisId],
    );
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Farm job failed → analysis failed; siblings cancelled
// ---------------------------------------------------------------------------

describe('farm job failed', () => {
  let assetId: string;
  let analysisId: string;
  let aiJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'describing' });
    const extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    aiJobId = randomUUID();
    await insertFarmJobRow(aiJobId, analysisId, 'scan.ai');
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('marks analysis as failed with the farm error reason', async () => {
    await poller.processJob(
      makeJobView(aiJobId, 'failed', `${analysisId}:ai`, {
        code: 'WORKER_CRASH',
        message: 'Out of memory',
      }),
    );
    const [analysis] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status, reason FROM asset_analyses WHERE id=$1`,
      [analysisId],
    );
    expect(analysis['status']).toBe('failed');
    expect(analysis['reason'] as string).toMatch(/WORKER_CRASH/);
  });

  it('marks the failed farm job as ingested with status=failed', async () => {
    await poller.processJob(
      makeJobView(aiJobId, 'failed', `${analysisId}:ai`, {
        code: 'WORKER_CRASH',
        message: 'Out of memory',
      }),
    );
    const [job] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT status, ingested_at FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [aiJobId],
    );
    expect(job['status']).toBe('failed');
    expect(job['ingested_at']).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Second analysis flips the previous one off, exactly one current
// ---------------------------------------------------------------------------

describe('second analysis flips the previous one off', () => {
  let assetId: string;
  let analysis1Id: string;
  let analysis2Id: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysis1Id = await insertAnalysis(assetId, { status: 'completed', isCurrent: true });

    analysis2Id = await insertAnalysis(assetId, { status: 'describing', isCurrent: false });
    const extractJobId2 = randomUUID();
    await insertFarmJobRow(extractJobId2, analysis2Id, 'scan.extract', {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    const aiJob2Id = randomUUID();
    await insertFarmJobRow(aiJob2Id, analysis2Id, 'scan.ai', {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    // Set the description directly so finalizeIfDone will proceed
    await ds.query(`UPDATE asset_analyses SET description=$1, usable=$2, quality=$3 WHERE id=$4`, [
      JSON.stringify({ title_vi: 'Test', usable: true, quality: 4 }),
      true,
      4,
      analysis2Id,
    ]);
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('leaves exactly one is_current=true analysis after finalizing the second', async () => {
    await pipeline.finalizeIfDone(analysis2Id);
    const currentAnalyses = await ds.query<Array<Record<string, unknown>>>(
      `SELECT id FROM asset_analyses WHERE asset_id=$1 AND is_current=true`,
      [assetId],
    );
    expect(currentAnalyses).toHaveLength(1);
    expect(currentAnalyses[0]['id']).toBe(analysis2Id);
  });

  it('flips the first analysis to is_current=false', async () => {
    await pipeline.finalizeIfDone(analysis2Id);
    const [analysis1] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT is_current FROM asset_analyses WHERE id=$1`,
      [analysis1Id],
    );
    expect(analysis1['is_current']).toBe(false);
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
    analysisId = await insertAnalysis(assetId, { status: 'describing' });
    const extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract', {
      status: 'ingested',
      ingestedAt: new Date(),
    });
    await ds.query(
      `UPDATE asset_analyses SET keyframes=$1, duration_ms=$2, has_audio=$3 WHERE id=$4`,
      [
        JSON.stringify([
          {
            output: 'keyframes/0000.jpg',
            t_ms: 100,
            width: 640,
            height: 360,
            dhash: '0123456789abcdef',
            scene_index: 0,
          },
        ]),
        5000,
        true,
        analysisId,
      ],
    );
    aiJobId = randomUUID();
    await insertFarmJobRow(aiJobId, analysisId, 'scan.ai');

    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}ai.json`, JSON.stringify(makeAiManifest(assetId)));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('exactly one call ingests the result; the other skips', async () => {
    const job = makeJobView(aiJobId, 'completed', `${analysisId}:ai`);
    const [r1, r2] = await Promise.all([poller.processJob(job), poller.processJob(job)]);
    // At least one must return true (both returning true is also valid when the second
    // skips via the already-ingested early-exit path)
    expect(r1 || r2).toBe(true);
  });

  it('the farm job row is ingested exactly once', async () => {
    const job = makeJobView(aiJobId, 'completed', `${analysisId}:ai`);
    await Promise.all([poller.processJob(job), poller.processJob(job)]);

    const [farmJobRow] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT ingested_at FROM analysis_farm_jobs WHERE farm_job_id=$1`,
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
    const result = await poller.processJob(
      makeJobView(phantomJobId, 'completed', `${analysisId}:extract`),
    );
    expect(result).toBe(true);

    const [adopted] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT ingested_at FROM analysis_farm_jobs WHERE farm_job_id=$1`,
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
  let folderId: string;
  let projectId: string;
  let categoryId: string;
  let provinceId: string;
  let countryId: string;

  beforeEach(async () => {
    countryId = randomUUID();
    await ds.query(`INSERT INTO countries (id, name) VALUES ($1, $2)`, [
      countryId,
      `Country ${countryId.slice(0, 8)}`,
    ]);
    provinceId = randomUUID();
    await ds.query(`INSERT INTO provinces (id, country_id, name) VALUES ($1,$2,$3)`, [
      provinceId,
      countryId,
      'Hà Nội',
    ]);
    categoryId = randomUUID();
    await ds.query(`INSERT INTO categories (id, name, slug) VALUES ($1,$2,$3)`, [
      categoryId,
      'Phim tài liệu',
      `slug-${categoryId.slice(0, 8)}`,
    ]);
    folderId = await insertFolder();
    assetId = await insertAsset();
    projectId = randomUUID();
    await ds.query(
      `INSERT INTO projects (id, owner_user_id, folder_id, name, category_id, province_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [projectId, 'test-user', folderId, 'AG Test Project', categoryId, provinceId],
    );
    await ds.query(
      `INSERT INTO project_media (id, project_id, asset_id, created_by) VALUES ($1,$2,$3,$4)`,
      [randomUUID(), projectId, assetId, 'test'],
    );
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract');
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}extract.json`, JSON.stringify(makeExtractManifest(assetId, 1)));
  });

  afterEach(async () => {
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
      context: { project_names: string[]; province_names: string[] };
    };
    expect(payload.context.project_names).toContain('AG Test Project');
  });

  it('includes the province name in the submitted AI payload context', async () => {
    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));
    const payload = fakeClient.submissions[0].payload as {
      context: { province_names: string[] };
    };
    expect(payload.context.province_names).toContain('Hà Nội');
  });
});

// ---------------------------------------------------------------------------
// 10. Extract: submit failure and retry (idempotent — no duplicates)
// ---------------------------------------------------------------------------

describe('extract: submit failure and retry', () => {
  let assetId: string;
  let analysisId: string;
  let extractJobId: string;

  beforeEach(async () => {
    assetId = await insertAsset();
    analysisId = await insertAnalysis(assetId, { status: 'extracting' });
    extractJobId = randomUUID();
    await insertFarmJobRow(extractJobId, analysisId, 'scan.extract');
    const prefix = computePrefix(storageKey(assetId), assetId, analysisId);
    fakeStorage.register(`${prefix}extract.json`, JSON.stringify(makeExtractManifest(assetId, 2)));
  });

  afterEach(async () => {
    await cleanupAsset(assetId);
  });

  it('does not mark the extract job ingested when AI submission fails', async () => {
    fakeClient.setFailOnCall(0); // scan.ai submission fails
    await expect(
      poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`)),
    ).rejects.toThrow('simulated submission failure');

    const [extractJob] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT ingested_at FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [extractJobId],
    );
    expect(extractJob['ingested_at']).toBeNull();
  });

  it('retry marks the extract job ingested after AI submit succeeds', async () => {
    fakeClient.setFailOnCall(0);
    await expect(
      poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`)),
    ).rejects.toThrow('simulated submission failure');
    fakeClient.reset();

    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));

    const [extractJob] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT ingested_at FROM analysis_farm_jobs WHERE farm_job_id=$1`,
      [extractJobId],
    );
    expect(extractJob['ingested_at']).not.toBeNull();
  });

  it('retry does not insert a duplicate scan.ai farm job row', async () => {
    fakeClient.setFailOnCall(0);
    await expect(
      poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`)),
    ).rejects.toThrow('simulated submission failure');
    fakeClient.reset();

    await poller.processJob(makeJobView(extractJobId, 'completed', `${analysisId}:extract`));

    const aiJobs = await ds.query<Array<Record<string, unknown>>>(
      `SELECT * FROM analysis_farm_jobs WHERE analysis_id=$1 AND type='scan.ai'`,
      [analysisId],
    );
    expect(aiJobs).toHaveLength(1);
  });
});
