/**
 * DB-level tests for scan batches: the automatic batch, progress counts, and pause / resume /
 * cancel of a whole batch (farm group actions + parking and resuming its analyses).
 * Runs against the test Postgres (port 55434); the farm is faked.
 */
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { OutboxService } from '../../common/outbox.service';
import { AppDataSource } from '../../database/data-source';
import { AnalysisBatchEntity } from '../../database/entities/analysis-batch.entity';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import { SystemLogService } from '../logs/system-log.service';
import { AnalysisBatchService } from './analysis-batch.service';
import { autoBatchId, batchGroupKey } from './analysis-batches';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';
import type { FarmClient } from './farm/farm-client';
import type { JobControlAction, SubmitJobRequest, SubmitJobResponse } from './farm/protocol';

jest.mock('uuid', () => {
  let n = 0;
  return { v7: () => `00000000-0000-7000-9000-${String(++n).padStart(12, '0')}` };
});
jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

/** Records submissions and group/id controls. */
class FakeFarmClient {
  submissions: SubmitJobRequest[] = [];
  controls: Array<{ action: JobControlAction; selector: { ids?: string[]; group_key?: string } }> =
    [];

  get isConfigured(): boolean {
    return true;
  }

  async submitJob(request: SubmitJobRequest): Promise<SubmitJobResponse> {
    this.submissions.push(request);
    const now = new Date().toISOString();
    return {
      job: {
        id: randomUUID(),
        owner: 'ag-go',
        type: request.type,
        lane: 'batch',
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
        created_at: now,
        updated_at: now,
        finished_at: null,
        acked_at: null,
      },
      created: true,
    };
  }

  async controlJobs(
    action: JobControlAction,
    selector: { ids: string[] } | { group_key: string },
  ): Promise<number> {
    this.controls.push({ action, selector });
    return 0;
  }

  async cancelJob(): Promise<void> {}

  reset(): void {
    this.submissions = [];
    this.controls = [];
  }
}

let ds: DataSource;
let farm: FakeFarmClient;
let pipeline: AnalysisPipelineService;
let batches: AnalysisBatchService;
const createdAssets: string[] = [];
const createdBatches: string[] = [];

async function insertAsset(): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO assets
       (id, asset_type, original_filename, mime_type, file_size_bytes, storage_provider,
        original_bucket, original_storage_key, processing_status, source_type, source_metadata, created_by)
     VALUES ($1,'video','clip.mp4','video/mp4',1024,'r2','ag-go',$2,'ready','local','{}','test')`,
    [id, `projects/p1/originals/${id}/clip.mp4`],
  );
  createdAssets.push(id);
  return id;
}

async function insertBatch(
  kind: 'backfill' | 'auto' = 'backfill',
  status = 'running',
): Promise<string> {
  const rows = (await ds.query(
    `INSERT INTO analysis_batches (name, kind, mode, status) VALUES ($1, $2, $3, $4) RETURNING id`,
    [`batch-${randomUUID().slice(0, 8)}`, kind, kind === 'auto' ? null : 'all', status],
  )) as Array<{ id: string }>;
  createdBatches.push(rows[0]!.id);
  return rows[0]!.id;
}

async function insertAnalysis(
  batchId: string,
  status: string,
  extra: { keyframes?: unknown; durationMs?: number } = {},
): Promise<{ assetId: string; analysisId: string }> {
  const assetId = await insertAsset();
  const analysisId = randomUUID();
  await ds.query(
    `INSERT INTO asset_analyses
       (id, asset_id, status, priority, extract_version, prompt_version, is_current, batch_id, keyframes, duration_ms, has_audio)
     VALUES ($1,$2,$3,0,'x2','p2',false,$4,$5,$6,true)`,
    [
      analysisId,
      assetId,
      status,
      batchId,
      extra.keyframes ? JSON.stringify(extra.keyframes) : null,
      extra.durationMs ?? null,
    ],
  );
  return { assetId, analysisId };
}

async function insertFarmJob(analysisId: string, type: string, ingested: boolean): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO analysis_farm_jobs (farm_job_id, analysis_id, type, status, ingested_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, analysisId, type, ingested ? 'ingested' : 'submitted', ingested ? new Date() : null],
  );
  return id;
}

async function statusOf(analysisId: string): Promise<string> {
  const rows = (await ds.query(`SELECT status FROM asset_analyses WHERE id = $1`, [
    analysisId,
  ])) as Array<{
    status: string;
  }>;
  return rows[0]!.status;
}

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  farm = new FakeFarmClient();
  const sysLog = new SystemLogService(ds.getRepository(SystemLogEntity));
  const analysisLog = new AnalysisLogService(sysLog, ds.getRepository(SystemLogEntity));
  const config = {
    get: (key: string) => (key === 'ANALYSIS_MODEL' ? 'qwen2.5vl:3b' : undefined),
  } as unknown as ConfigService;
  pipeline = new AnalysisPipelineService(
    ds,
    ds.getRepository(AssetAnalysisEntity),
    ds.getRepository(AnalysisBatchEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AnalysisFarmJobEntity),
    farm as unknown as FarmClient,
    new OutboxService(ds.getRepository(OutboxEventEntity)),
    analysisLog,
    config,
  );
  batches = new AnalysisBatchService(
    ds,
    ds.getRepository(AnalysisBatchEntity),
    ds.getRepository(AssetAnalysisEntity),
    pipeline,
    farm as unknown as FarmClient,
    analysisLog,
    { enrich: (rows: unknown[]) => Promise.resolve(rows) } as unknown as ActorEnrichmentService,
  );
});

afterEach(async () => {
  farm.reset();
  if (createdAssets.length) {
    await ds.query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [createdAssets.splice(0)]);
  }
  if (createdBatches.length) {
    await ds.query(`DELETE FROM analysis_batches WHERE id = ANY($1::uuid[])`, [
      createdBatches.splice(0),
    ]);
  }
});

afterAll(async () => {
  if (ds.isInitialized) await ds.destroy();
});

describe('automatic batch', () => {
  it('is created once and reused', async () => {
    await ds.query(`DELETE FROM analysis_batches WHERE kind = 'auto'`);
    const first = await autoBatchId(ds.manager);
    const second = await autoBatchId(ds.manager);
    createdBatches.push(first);
    expect(second).toBe(first);
    const rows = (await ds.query(
      `SELECT count(*)::int AS n FROM analysis_batches WHERE kind = 'auto'`,
    )) as Array<{
      n: number;
    }>;
    expect(rows[0]!.n).toBe(1);
  });

  it('stays open when its work is cancelled (new uploads keep joining it)', async () => {
    await ds.query(`DELETE FROM analysis_batches WHERE kind = 'auto'`);
    const autoId = await insertBatch('auto');
    const { analysisId } = await insertAnalysis(autoId, 'queued');
    const view = await batches.cancel(autoId, null);
    expect(view.status).toBe('running');
    expect(await statusOf(analysisId)).toBe('cancelled');
  });
});

describe('progress counts and the derived completed status', () => {
  it('counts per status and reports a finished backfill as completed', async () => {
    const done = await insertBatch();
    await insertAnalysis(done, 'completed');
    await insertAnalysis(done, 'failed');
    await insertAnalysis(done, 'cancelled');
    const busy = await insertBatch();
    await insertAnalysis(busy, 'completed');
    await insertAnalysis(busy, 'paused');
    await insertAnalysis(busy, 'describing');

    const doneView = await batches.get(done);
    expect(doneView.status).toBe('completed');
    expect(doneView.counts).toEqual({
      total: 3,
      queued: 0,
      running: 0,
      completed: 1,
      failed: 1,
      cancelled: 1,
    });

    const busyView = await batches.get(busy);
    expect(busyView.status).toBe('running');
    // paused counts as waiting (queued); describing as running
    expect(busyView.counts).toMatchObject({ total: 3, queued: 1, running: 1, completed: 1 });

    const completedPage = await batches.list({
      page: 1,
      pageSize: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      status: 'completed',
    });
    const runningPage = await batches.list({
      page: 1,
      pageSize: 100,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      status: 'running',
    });
    expect(completedPage.items.map((b) => b.id)).toContain(done);
    expect(completedPage.items.map((b) => b.id)).not.toContain(busy);
    expect(runningPage.items.map((b) => b.id)).toContain(busy);
    expect(runningPage.items.map((b) => b.id)).not.toContain(done);
  });
});

describe('pause / resume / cancel a batch', () => {
  it('pause parks unfinished analyses and pauses the farm group; resume sends only what was never sent', async () => {
    const batchId = await insertBatch();
    const neverSent = await insertAnalysis(batchId, 'queued');
    const extracting = await insertAnalysis(batchId, 'extracting');
    await insertFarmJob(extracting.analysisId, 'scan.extract', false);
    const extracted = await insertAnalysis(batchId, 'extracted', {
      keyframes: [
        {
          output: 'keyframes/0001.jpg',
          t_ms: 500,
          width: 640,
          height: 360,
          dhash: '0123456789abcdef',
          scene_index: 0,
        },
      ],
      durationMs: 8000,
    });
    await insertFarmJob(extracted.analysisId, 'scan.extract', true);
    const finished = await insertAnalysis(batchId, 'completed');

    const paused = await batches.pause(batchId, null);
    expect(paused.status).toBe('paused');
    expect(farm.controls).toEqual([
      { action: 'pause', selector: { group_key: batchGroupKey(batchId) } },
    ]);
    for (const a of [neverSent, extracting, extracted])
      expect(await statusOf(a.analysisId)).toBe('paused');
    expect(await statusOf(finished.analysisId)).toBe('completed');

    // A paused batch holds back new submissions (e.g. an outbox event still in flight)
    await ds.query(`UPDATE asset_analyses SET status = 'queued' WHERE id = $1`, [
      neverSent.analysisId,
    ]);
    await pipeline.submitExtract(neverSent.analysisId);
    expect(farm.submissions).toHaveLength(0);
    expect(await statusOf(neverSent.analysisId)).toBe('paused');

    farm.reset();
    const resumed = await batches.resume(batchId, null);
    expect(resumed.status).toBe('running');
    expect(farm.controls[0]).toEqual({
      action: 'resume',
      selector: { group_key: batchGroupKey(batchId) },
    });
    // the never-sent analysis gets its extract, the extracted one its description job; nothing is re-sent
    const byType = farm.submissions.map((s) => [s.type, s.correlation_id, s.group_key]);
    expect(byType).toEqual(
      expect.arrayContaining([
        ['scan.extract', `${neverSent.analysisId}:extract`, batchGroupKey(batchId)],
        ['scan.ai', `${extracted.analysisId}:ai`, batchGroupKey(batchId)],
      ]),
    );
    expect(farm.submissions).toHaveLength(2);
    expect(await statusOf(neverSent.analysisId)).toBe('extracting');
    expect(await statusOf(extracting.analysisId)).toBe('extracting');
    expect(await statusOf(extracted.analysisId)).toBe('describing');
  });

  it('cancel cancels everything unfinished and the farm group, and closes the batch', async () => {
    const batchId = await insertBatch();
    const queued = await insertAnalysis(batchId, 'queued');
    const describing = await insertAnalysis(batchId, 'describing');
    const finished = await insertAnalysis(batchId, 'completed');

    const view = await batches.cancel(batchId, null);
    expect(view.status).toBe('cancelled');
    expect(farm.controls).toEqual([
      { action: 'cancel', selector: { group_key: batchGroupKey(batchId) } },
    ]);
    expect(await statusOf(queued.analysisId)).toBe('cancelled');
    expect(await statusOf(describing.analysisId)).toBe('cancelled');
    expect(await statusOf(finished.analysisId)).toBe('completed');

    // A cancelled batch never sends its analyses again
    await ds.query(`UPDATE asset_analyses SET status = 'queued' WHERE id = $1`, [
      queued.analysisId,
    ]);
    await pipeline.submitExtract(queued.analysisId);
    expect(farm.submissions).toHaveLength(0);
    expect(await statusOf(queued.analysisId)).toBe('cancelled');
  });
});

describe('pause / resume / cancel one analysis', () => {
  it('acts on the farm jobs of that analysis only', async () => {
    const batchId = await insertBatch();
    const target = await insertAnalysis(batchId, 'extracting');
    const extractJob = await insertFarmJob(target.analysisId, 'scan.extract', false);
    const other = await insertAnalysis(batchId, 'extracting');

    expect(await pipeline.pause(target.analysisId)).toBe(true);
    expect(farm.controls).toEqual([{ action: 'pause', selector: { ids: [extractJob] } }]);
    expect(await statusOf(target.analysisId)).toBe('paused');
    expect(await statusOf(other.analysisId)).toBe('extracting');

    farm.reset();
    expect(await pipeline.resume(target.analysisId)).toBe(true);
    expect(farm.controls).toEqual([{ action: 'resume', selector: { ids: [extractJob] } }]);
    expect(await statusOf(target.analysisId)).toBe('extracting');

    farm.reset();
    expect(await pipeline.cancel(target.analysisId, 'test')).toBe(true);
    expect(farm.controls).toEqual([{ action: 'cancel', selector: { ids: [extractJob] } }]);
    expect(await statusOf(target.analysisId)).toBe('cancelled');
    // Finished analyses are left alone
    expect(await pipeline.cancel(target.analysisId, 'again')).toBe(false);
  });
});
