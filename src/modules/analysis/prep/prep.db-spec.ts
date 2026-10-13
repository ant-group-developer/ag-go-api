/**
 * DB-level tests of the prep pipeline: enqueue → scan.prep → ingest prep.json → studio.transcribe →
 * ingest transcribe.json → ready and current. Runs against the test Postgres (port 55434); the farm
 * and the storage are faked.
 */
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { OutboxService } from '../../../common/outbox.service';
import { AppDataSource } from '../../../database/data-source';
import { AnalysisFarmJobEntity } from '../../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../../database/entities/asset-analysis.entity';
import { AssetPrepBatchEntity } from '../../../database/entities/asset-prep-batch.entity';
import { AssetPrepFarmJobEntity } from '../../../database/entities/asset-prep-farm-job.entity';
import { AssetPrepEntity } from '../../../database/entities/asset-prep.entity';
import { AssetEntity } from '../../../database/entities/asset.entity';
import { OutboxEventEntity } from '../../../database/entities/outbox-event.entity';
import { SystemLogEntity } from '../../../database/entities/system-log.entity';
import type { StorageAdapter } from '../../assets/storage/storage-adapter';
import { SystemLogService } from '../../logs/system-log.service';
import { assetVariantsPrefix } from '../../projects/project-asset-cleanup';
import { AnalysisLogService } from '../analysis-log.service';
import type { AnalysisPipelineService } from '../analysis-pipeline.service';
import { FarmResultPollerService } from '../farm-result-poller.service';
import type { FarmClient } from '../farm/farm-client';
import type { ListedJob, SubmitJobRequest, SubmitJobResponse } from '../farm/protocol';
import type { ScanPrepManifest } from '../farm/scan';
import type { TranscribeManifest } from '../farm/studio';
import { prepPrefix } from './prep-batches';
import { PrepIngestService } from './prep-ingest.service';
import { PrepPipelineService } from './prep-pipeline.service';
import { PrepStudioService } from './prep-studio.service';
import { PrepService } from './prep.service';

// Ids stay unique across runs: the test database keeps its rows
jest.mock('uuid', () => ({
  v7: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));
jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

class FakeFarmClient {
  submissions: SubmitJobRequest[] = [];
  acked: string[] = [];
  cancelled: string[] = [];
  private readonly byCorrelation = new Map<string, string>();

  get isConfigured(): boolean {
    return true;
  }

  async submitJob(request: SubmitJobRequest): Promise<SubmitJobResponse> {
    let id = this.byCorrelation.get(request.correlation_id);
    if (!id) {
      id = randomUUID();
      this.byCorrelation.set(request.correlation_id, id);
    }
    this.submissions.push(request);
    return { job: jobView(id, request.type, 'queued', request.correlation_id), created: true };
  }

  jobIdOf(correlationId: string): string {
    return this.byCorrelation.get(correlationId)!;
  }

  queue: ListedJob[] = [];
  async listUnackedFinished(): Promise<ListedJob[]> {
    return this.queue;
  }
  async ackJob(id: string): Promise<void> {
    this.acked.push(id);
  }
  async cancelJob(id: string): Promise<void> {
    this.cancelled.push(id);
  }
  async controlJobs(): Promise<number> {
    return 0;
  }
  raised: Array<{ id: string; lane?: string; priority: number }> = [];
  async raiseJob(id: string, request: { lane?: string; priority: number }): Promise<void> {
    this.raised.push({ id, ...request });
  }
  jobs = new Map<string, Partial<SubmitJobResponse['job']>>();
  async getJob(id: string): Promise<SubmitJobResponse['job']> {
    return { ...jobView(id, 'scan.prep', 'queued', 'x'), ...(this.jobs.get(id) ?? {}) };
  }
}

class FakeStorage {
  objects = new Map<string, string>();
  deleted: string[] = [];
  async getObjectText(key: string): Promise<string> {
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`no object ${key}`);
    return value;
  }
  async getPresignedGetUrl(key: string): Promise<string> {
    return `https://r2.test/${key}`;
  }
  async deleteObject(key: string): Promise<void> {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

function jobView(
  id: string,
  type: string,
  status: 'queued' | 'completed' | 'failed',
  correlationId: string,
): SubmitJobResponse['job'] {
  const now = new Date().toISOString();
  return {
    id,
    owner: 'ag-go',
    type: type as SubmitJobResponse['job']['type'],
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
    error: status === 'failed' ? { code: 'boom', message: 'worker died', retryable: false } : null,
    created_at: now,
    updated_at: now,
    finished_at: status === 'queued' ? null : now,
    acked_at: null,
  };
}

function prepManifest(assetId: string, withAudio = true): ScanPrepManifest {
  return {
    schema: 'ag.scan.prep/v1',
    asset_id: assetId,
    media: { duration_s: 25, width: 854, height: 480, fps: 25, has_audio: true },
    scene: { threshold: 0.3, min_shot_s: 1, max_shot_s: 20 },
    shots: [
      { n: 1, in: 0, out: 12.5, frame: 'frames/001.jpg' },
      { n: 2, in: 12.5, out: 25, frame: 'frames/002.jpg' },
    ],
    sheets: [{ file: 'sheets/01.jpg', shots: [1, 2] }],
    audio: withAudio ? 'audio.wav' : null,
  };
}

function transcribeManifest(prepId: string, assetId: string): TranscribeManifest {
  return {
    schema: 'ag.studio.transcribe/v1',
    production_id: prepId,
    engine: { name: 'whisperx', version: '3.1' },
    sources: [
      {
        source_id: assetId,
        language: 'vi',
        alignment: 'word',
        segments: [
          { start: 0, end: 2, text: ' Xin chào ', words: [{ word: 'Xin', start: 0, end: 1 }] },
          { start: 3, end: 4, text: 'các bạn', words: [] },
        ],
      },
    ],
  };
}

let ds: DataSource;
let farm: FakeFarmClient;
let storage: FakeStorage;
let pipeline: PrepPipelineService;
let poller: FarmResultPollerService;

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  farm = new FakeFarmClient();
  storage = new FakeStorage();
  const sysLog = new SystemLogService(ds.getRepository(SystemLogEntity));
  const analysisLog = new AnalysisLogService(sysLog, ds.getRepository(SystemLogEntity));
  const config = { get: () => undefined } as unknown as ConfigService;
  pipeline = new PrepPipelineService(
    ds,
    ds.getRepository(AssetPrepEntity),
    ds.getRepository(AssetPrepBatchEntity),
    ds.getRepository(AssetPrepFarmJobEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AssetAnalysisEntity),
    storage as unknown as StorageAdapter,
    farm as unknown as FarmClient,
    new OutboxService(ds.getRepository(OutboxEventEntity)),
    analysisLog,
    config,
  );
  const ingest = new PrepIngestService(
    ds.getRepository(AssetPrepEntity),
    ds.getRepository(AssetPrepFarmJobEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AssetAnalysisEntity),
    storage as unknown as StorageAdapter,
    farm as unknown as FarmClient,
    pipeline,
  );
  poller = new FarmResultPollerService(
    ds,
    ds.getRepository(AssetAnalysisEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AnalysisFarmJobEntity),
    storage as unknown as StorageAdapter,
    farm as unknown as FarmClient,
    {} as AnalysisPipelineService,
    analysisLog,
    config,
    ingest,
  );
});

afterAll(async () => {
  if (ds.isInitialized) await ds.destroy();
});

beforeEach(() => {
  farm.submissions = [];
  farm.acked = [];
  farm.queue = [];
  storage.objects.clear();
  storage.deleted = [];
});

async function insertAsset(): Promise<AssetEntity> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO assets (id, asset_type, original_filename, mime_type, file_size_bytes, storage_provider,
       original_bucket, original_storage_key, processing_status, source_type, source_metadata, created_by)
     VALUES ($1,'video','clip.mp4','video/mp4',1000,'r2','ag-go',$2,'ready','local','{}','test')`,
    [id, `projects/p1/originals/${id}/clip.mp4`],
  );
  return ds.getRepository(AssetEntity).findOneByOrFail({ id });
}

async function insertAnalysis(assetId: string, hasSpeech: boolean | null): Promise<void> {
  await ds.query(
    `INSERT INTO asset_analyses (id, asset_id, status, priority, extract_version, prompt_version, is_current, has_audio, has_speech)
     VALUES ($1,$2,'completed',0,'x2','p2',true,true,$3)`,
    [randomUUID(), assetId, hasSpeech],
  );
}

async function enqueue(asset: AssetEntity, lane: 'batch' | 'interactive' = 'batch') {
  const id = await ds.transaction((manager) =>
    pipeline.enqueueInsideTransaction(manager, asset, {
      lane,
      priority: lane === 'batch' ? -10 : 50,
    }),
  );
  return id!;
}

function prefixOf(asset: AssetEntity, prepId: string): string {
  return prepPrefix(assetVariantsPrefix(asset.originalStorageKey, asset.id), prepId);
}

async function prep(id: string): Promise<AssetPrepEntity> {
  return ds.getRepository(AssetPrepEntity).findOneByOrFail({ id });
}

async function finish(
  correlationId: string,
  type: string,
  status: 'completed' | 'failed' = 'completed',
): Promise<void> {
  farm.queue = [jobView(farm.jobIdOf(correlationId), type, status, correlationId)];
  await poller.poll();
}

describe('prep pipeline', () => {
  it('cuts, transcribes and becomes the current prep', async () => {
    const asset = await insertAsset();
    const prepId = await enqueue(asset);
    const outbox = await ds.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1`, [
      prepId,
    ]);
    expect(outbox).toEqual([{ event_type: 'asset.prep.requested' }]);

    await pipeline.handlePrepRequested(prepId);
    const submitted = farm.submissions[0];
    expect(submitted).toMatchObject({
      type: 'scan.prep',
      lane: 'batch',
      priority: -10,
      correlation_id: `${prepId}:prep`,
      group_key: null,
    });
    expect(submitted.payload).toMatchObject({
      asset_id: asset.id,
      source: 'source',
      params: { frame_width: 480, sheet_cols: 4, sheet_shots: 16, audio: true },
    });
    expect((await prep(prepId)).status).toBe('cutting');

    const prefix = prefixOf(asset, prepId);
    storage.objects.set(`${prefix}prep.json`, JSON.stringify(prepManifest(asset.id)));
    await finish(`${prepId}:prep`, 'scan.prep');
    const cut = await prep(prepId);
    expect(cut.status).toBe('transcribing');
    expect(cut.shots).toHaveLength(2);
    expect(cut.sheets).toEqual([{ file: 'sheets/01.jpg', shots: [1, 2] }]);
    expect(cut.durationS).toBe(25);
    expect(farm.submissions[1]).toMatchObject({
      type: 'studio.transcribe',
      correlation_id: `${prepId}:transcribe`,
      payload: {
        production_id: prepId,
        model: 'large-v3',
        align_words: true,
        sources: [{ source_id: asset.id, audio: 'artifact:audio.wav', language: null }],
      },
    });

    storage.objects.set(
      `${prefix}transcribe.json`,
      JSON.stringify(transcribeManifest(prepId, asset.id)),
    );
    await finish(`${prepId}:transcribe`, 'studio.transcribe');
    const ready = await prep(prepId);
    expect(ready).toMatchObject({
      status: 'ready',
      isCurrent: true,
      transcriptStatus: 'done',
      language: 'vi',
      transcriptText: 'Xin chào các bạn',
    });
    expect(ready.transcript?.engine).toBe('whisperx');
    expect(ready.transcript?.segments[0].words).toEqual([{ word: 'Xin', start: 0, end: 1 }]);
    expect(storage.deleted).toContain(`${prefix}audio.wav`);
    expect(farm.acked).toHaveLength(2);

    // A second prep of the same asset takes over as the current one
    const second = await ds.transaction((manager) =>
      pipeline.enqueueInsideTransaction(manager, asset, {
        lane: 'batch',
        priority: 0,
        skipIfPrepared: false,
      }),
    );
    await pipeline.handlePrepRequested(second!);
    storage.objects.set(
      `${prefixOf(asset, second!)}prep.json`,
      JSON.stringify({
        ...prepManifest(asset.id, false),
        media: { ...prepManifest(asset.id).media, has_audio: false },
      }),
    );
    await finish(`${second}:prep`, 'scan.prep');
    expect(await prep(second!)).toMatchObject({
      status: 'ready',
      isCurrent: true,
      transcriptStatus: 'none',
    });
    expect((await prep(prepId)).isCurrent).toBe(false);
  });

  it('skips the transcript when the analysis found no speech', async () => {
    const asset = await insertAsset();
    await insertAnalysis(asset.id, false);
    const prepId = await enqueue(asset);
    await pipeline.handlePrepRequested(prepId);
    expect(farm.submissions[0].payload).toMatchObject({ params: { audio: false } });
    storage.objects.set(
      `${prefixOf(asset, prepId)}prep.json`,
      JSON.stringify(prepManifest(asset.id, false)),
    );
    await finish(`${prepId}:prep`, 'scan.prep');
    expect(await prep(prepId)).toMatchObject({ status: 'ready', transcriptStatus: 'skipped' });
    expect(farm.submissions).toHaveLength(1);
  });

  it('keeps the prep ready when the transcript fails', async () => {
    const asset = await insertAsset();
    const prepId = await enqueue(asset);
    await pipeline.handlePrepRequested(prepId);
    storage.objects.set(
      `${prefixOf(asset, prepId)}prep.json`,
      JSON.stringify(prepManifest(asset.id)),
    );
    await finish(`${prepId}:prep`, 'scan.prep');
    await finish(`${prepId}:transcribe`, 'studio.transcribe', 'failed');
    const done = await prep(prepId);
    expect(done).toMatchObject({ status: 'ready', isCurrent: true, transcriptStatus: 'failed' });
    expect(done.error).toContain('worker died');
    expect(storage.deleted).toContain(`${prefixOf(asset, prepId)}audio.wav`);
  });

  it('fails the prep when scan.prep fails', async () => {
    const asset = await insertAsset();
    const prepId = await enqueue(asset);
    await pipeline.handlePrepRequested(prepId);
    await finish(`${prepId}:prep`, 'scan.prep', 'failed');
    expect(await prep(prepId)).toMatchObject({ status: 'failed', isCurrent: false });
  });

  it('fails the prep when prep.json cannot be read', async () => {
    const asset = await insertAsset();
    const prepId = await enqueue(asset);
    await pipeline.handlePrepRequested(prepId);
    await finish(`${prepId}:prep`, 'scan.prep');
    const failed = await prep(prepId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('prep.json');
  });

  it('adopts a prep result whose farm job row was never saved', async () => {
    const asset = await insertAsset();
    const prepId = await enqueue(asset);
    await pipeline.handlePrepRequested(prepId);
    const jobId = farm.jobIdOf(`${prepId}:prep`);
    await ds.query(`DELETE FROM asset_prep_farm_jobs WHERE farm_job_id = $1`, [jobId]);
    storage.objects.set(
      `${prefixOf(asset, prepId)}prep.json`,
      JSON.stringify(prepManifest(asset.id)),
    );
    await finish(`${prepId}:prep`, 'scan.prep');
    expect((await prep(prepId)).status).toBe('transcribing');
  });

  it('does not enqueue twice while a prep runs or once one is current', async () => {
    const asset = await insertAsset();
    await enqueue(asset);
    const again = await ds.transaction((manager) =>
      pipeline.enqueueInsideTransaction(manager, asset, { lane: 'batch', priority: 0 }),
    );
    expect(again).toBeNull();
  });

  it('acks a finished job nobody owns', async () => {
    farm.queue = [
      {
        ...jobView(randomUUID(), 'studio.render_final', 'completed', 'x'),
        type: 'studio.render_final',
      },
    ];
    await poller.poll();
    expect(farm.acked).toHaveLength(1);
  });
});

describe('prep backfill and batches', () => {
  let service: PrepService;
  let asset: AssetEntity;

  beforeAll(() => {
    service = new PrepService(
      ds,
      ds.getRepository(AssetPrepEntity),
      ds.getRepository(AssetPrepBatchEntity),
      pipeline,
      farm as unknown as FarmClient,
      new OutboxService(ds.getRepository(OutboxEventEntity)),
    );
  });

  beforeEach(async () => {
    // Earlier runs leave footage behind: prepare it so only this test's asset is missing
    await ds.query(
      `UPDATE asset_preps SET status = 'cancelled' WHERE status IN ('queued','cutting','transcribing')`,
    );
    const folderId = randomUUID();
    const name = `prep-${folderId.slice(0, 8)}`;
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
    asset = await insertAsset();
    await ds.query(
      `INSERT INTO project_media (id, project_id, asset_id, created_by) VALUES ($1,$2,$3,'test')`,
      [randomUUID(), projectId, asset.id],
    );
  });

  it('counts footage by prep state and queues the missing ones in a batch', async () => {
    const before = await service.stats();
    expect(before.counts.missing).toBeGreaterThanOrEqual(1);

    const dry = await service.backfill({ mode: 'missing', dryRun: true, requestedBy: 'u1' });
    expect(dry.batchId).toBeNull();
    expect(dry.count).toBeGreaterThanOrEqual(1);

    const run = await service.backfill({ mode: 'missing', requestedBy: 'u1' });
    expect(run.batchId).not.toBeNull();
    const queued = await ds.getRepository(AssetPrepEntity).findOneByOrFail({ assetId: asset.id });
    expect(queued).toMatchObject({
      status: 'queued',
      lane: 'batch',
      priority: -10,
      batchId: run.batchId,
    });
    const after = await service.stats();
    expect(after.counts.running).toBe(before.counts.running + run.count);
    expect(after.batches[0]).toMatchObject({
      id: run.batchId,
      status: 'running',
      total: run.count,
    });

    // A second backfill skips footage whose prep runs
    const again = await service.backfill({ mode: 'all', dryRun: true, requestedBy: 'u1' });
    expect(again.count).toBe(0);
  });

  it('holds a paused batch and sends its preps when it resumes', async () => {
    const { batchId } = await service.backfill({ mode: 'missing', requestedBy: 'u1' });
    const prepRow = await ds.getRepository(AssetPrepEntity).findOneByOrFail({ assetId: asset.id });
    expect((await service.pause(batchId!)).status).toBe('paused');

    await pipeline.handlePrepRequested(prepRow.id);
    expect(farm.submissions).toHaveLength(0);
    expect((await prep(prepRow.id)).status).toBe('queued');

    expect((await service.resume(batchId!)).status).toBe('running');
    const events = await ds.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`,
      [prepRow.id],
    );
    expect(events[0].n).toBe(2);
    await pipeline.handlePrepRequested(prepRow.id);
    expect(farm.submissions[0]).toMatchObject({
      type: 'scan.prep',
      group_key: `prep-batch:${batchId}`,
    });
  });

  it('cancels the unfinished preps of a cancelled batch', async () => {
    const { batchId } = await service.backfill({ mode: 'missing', requestedBy: 'u1' });
    const view = await service.cancel(batchId!);
    expect(view.status).toBe('cancelled');
    const prepRow = await ds.getRepository(AssetPrepEntity).findOneByOrFail({ assetId: asset.id });
    expect(prepRow.status).toBe('cancelled');
  });
});

describe('prep for AG Studio', () => {
  let studio: PrepStudioService;

  beforeAll(() => {
    studio = new PrepStudioService(
      ds,
      ds.getRepository(AssetPrepEntity),
      ds.getRepository(AssetPrepFarmJobEntity),
      ds.getRepository(AssetEntity),
      storage as unknown as StorageAdapter,
      farm as unknown as FarmClient,
      pipeline,
      { get: () => undefined } as unknown as ConfigService,
    );
  });

  beforeEach(() => {
    farm.raised = [];
    farm.jobs.clear();
  });

  it('answers missing, then runs it interactive and reports the farm phase', async () => {
    const asset = await insertAsset();
    expect((await studio.read([asset.id])).items).toEqual([
      { assetId: asset.id, state: 'missing', phase: null, progress: null, error: null, prep: null },
    ]);

    const { items } = await studio.run([asset.id], 'user-1');
    expect(farm.submissions[0]).toMatchObject({
      type: 'scan.prep',
      lane: 'interactive',
      priority: 50,
    });
    expect(items[0]).toMatchObject({ state: 'running', phase: 'queued', progress: null });

    const prepRow = await ds.getRepository(AssetPrepEntity).findOneByOrFail({ assetId: asset.id });
    farm.jobs.set(farm.jobIdOf(`${prepRow.id}:prep`), { status: 'leased', progress_percent: 40 });
    expect((await studio.read([asset.id])).items[0]).toMatchObject({
      state: 'running',
      phase: 'cutting',
      progress: 0.4,
    });

    // Asking again while it runs interactive does nothing
    await studio.run([asset.id], 'user-1');
    expect(farm.submissions).toHaveLength(1);
  });

  it('returns a ready prep with signed frame and sheet URLs', async () => {
    const asset = await insertAsset();
    const prepId = await enqueue(asset);
    await pipeline.handlePrepRequested(prepId);
    const prefix = prefixOf(asset, prepId);
    storage.objects.set(`${prefix}prep.json`, JSON.stringify(prepManifest(asset.id)));
    await finish(`${prepId}:prep`, 'scan.prep');
    storage.objects.set(
      `${prefix}transcribe.json`,
      JSON.stringify(transcribeManifest(prepId, asset.id)),
    );
    await finish(`${prepId}:transcribe`, 'studio.transcribe');

    const [item] = (await studio.read([asset.id])).items;
    expect(item.state).toBe('ready');
    expect(item.prep).toMatchObject({
      prepId,
      durationS: 25,
      width: 854,
      height: 480,
      fps: 25,
      hasAudio: true,
      scene: { threshold: 0.3, minShotS: 1, maxShotS: 20 },
      transcriptStatus: 'done',
    });
    expect(item.prep?.shots[0]).toEqual({
      n: 1,
      in: 0,
      out: 12.5,
      frame: 'frames/001.jpg',
      url: `https://r2.test/${prefix}frames/001.jpg`,
    });
    expect(item.prep?.sheets[0].url).toBe(`https://r2.test/${prefix}sheets/01.jpg`);
    expect(item.prep?.transcript?.segments).toHaveLength(2);
  });

  it('raises a prep waiting in the batch lane, and sends one held by a paused batch', async () => {
    const waiting = await insertAsset();
    const waitingId = await enqueue(waiting);
    await pipeline.handlePrepRequested(waitingId);
    await studio.run([waiting.id], 'user-1');
    expect(farm.raised).toEqual([
      { id: farm.jobIdOf(`${waitingId}:prep`), lane: 'interactive', priority: 50 },
    ]);
    expect(await prep(waitingId)).toMatchObject({ lane: 'interactive', priority: 50 });

    const held = await insertAsset();
    const batch = await ds.getRepository(AssetPrepBatchEntity).save({
      name: 'b',
      mode: 'missing',
      priority: -10,
      status: 'paused',
      createdBy: null,
    });
    const heldId = await ds.transaction((manager) =>
      pipeline.enqueueInsideTransaction(manager, held, {
        lane: 'batch',
        priority: -10,
        batchId: batch.id,
      }),
    );
    await pipeline.handlePrepRequested(heldId!);
    expect(farm.submissions.filter((s) => s.correlation_id === `${heldId}:prep`)).toHaveLength(0);
    await studio.run([held.id], 'user-1');
    expect(farm.submissions.find((s) => s.correlation_id === `${heldId}:prep`)).toMatchObject({
      lane: 'interactive',
      priority: 50,
      group_key: null,
    });
  });

  it('reports a failed prep with its error, and runs a new one on request', async () => {
    const asset = await insertAsset();
    const prepId = await enqueue(asset);
    await pipeline.handlePrepRequested(prepId);
    await finish(`${prepId}:prep`, 'scan.prep', 'failed');
    const [item] = (await studio.read([asset.id])).items;
    expect(item).toMatchObject({ state: 'failed' });
    expect(item.error).toContain('worker died');

    const [again] = (await studio.run([asset.id], 'user-1')).items;
    expect(again.state).toBe('running');
  });
});
