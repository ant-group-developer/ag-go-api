/**
 * Unit tests for AnalysisPipelineService.
 * Everything is mocked — no database connection.
 */

import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import type { OutboxService } from '../../common/outbox.service';
import type { AnalysisBatchEntity } from '../../database/entities/analysis-batch.entity';
import type { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import type { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import type { AssetEntity } from '../../database/entities/asset.entity';
import type { AnalysisLogService } from './analysis-log.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';
import type { FarmClient } from './farm/farm-client';

jest.mock('uuid', () => {
  let n = 0;
  return { v7: () => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}` };
});

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSET_ID = randomUUID();
const ANALYSIS_ID = randomUUID();
const BATCH_ID = randomUUID();
const FARM_JOB_ID = randomUUID();

function makeAsset(overrides: Partial<AssetEntity> = {}): AssetEntity {
  return {
    id: ASSET_ID,
    assetType: 'video',
    originalFilename: 'clip.mp4',
    mimeType: 'video/mp4',
    fileSizeBytes: '102400',
    originalStorageKey: `projects/p1/originals/${ASSET_ID}/clip.mp4`,
    originalBucket: 'ag-go',
    storageProvider: 'r2',
    processingStatus: 'ready',
    sourceType: 'local',
    sourceMetadata: { durationSeconds: 10 },
    checksumSha256: 'a'.repeat(64),
    createdBy: 'test',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as AssetEntity;
}

function makeAnalysis(overrides: Partial<AssetAnalysisEntity> = {}): AssetAnalysisEntity {
  return {
    id: ANALYSIS_ID,
    assetId: ASSET_ID,
    status: 'queued',
    reason: null,
    priority: 0,
    extractVersion: 'x2',
    promptVersion: 'p2',
    batchId: null,
    description: null,
    describedAt: null,
    technical: null,
    keyframes: null,
    usable: null,
    quality: null,
    durationMs: null,
    orientation: null,
    hasAudio: null,
    hasSpeech: null,
    isCurrent: false,
    requestedBy: null,
    models: null,
    artifacts: null,
    summary: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  } as unknown as AssetAnalysisEntity;
}

function makeBatch(overrides: Partial<AnalysisBatchEntity> = {}): AnalysisBatchEntity {
  return {
    id: BATCH_ID,
    name: 'Test Batch',
    kind: 'backfill',
    status: 'running',
    ...overrides,
  } as unknown as AnalysisBatchEntity;
}

function makeFarmJob(overrides: Partial<AnalysisFarmJobEntity> = {}): AnalysisFarmJobEntity {
  return {
    farmJobId: FARM_JOB_ID,
    analysisId: ANALYSIS_ID,
    type: 'scan.extract',
    chunk: null,
    status: 'submitted',
    ingestedAt: null,
    lockedUntil: null,
    createdAt: new Date(),
    ...overrides,
  } as unknown as AnalysisFarmJobEntity;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

interface ServiceContext {
  service: AnalysisPipelineService;
  analysisRepo: jest.Mocked<Repository<AssetAnalysisEntity>>;
  batchRepo: jest.Mocked<Repository<AnalysisBatchEntity>>;
  assetRepo: jest.Mocked<Repository<AssetEntity>>;
  farmJobRepo: jest.Mocked<Repository<AnalysisFarmJobEntity>>;
  farmClient: jest.Mocked<FarmClient>;
  outboxService: jest.Mocked<OutboxService>;
  analysisLog: jest.Mocked<AnalysisLogService>;
  dataSource: jest.Mocked<DataSource>;
}

function makeService(
  overrides: {
    analysis?: AssetAnalysisEntity | null;
    batch?: AnalysisBatchEntity | null;
    asset?: AssetEntity | null;
    farmJobs?: AnalysisFarmJobEntity[];
    submitJobResult?: { job: { id: string; group_key: string | null } };
  } = {},
): ServiceContext {
  const { analysis = makeAnalysis(), batch = null, asset = makeAsset(), farmJobs = [] } = overrides;

  const analysisRepo = {
    findOne: jest.fn().mockResolvedValue(analysis),
    update: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(analysis ? 1 : 0),
    createQueryBuilder: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    }),
  } as unknown as jest.Mocked<Repository<AssetAnalysisEntity>>;

  const batchRepo = {
    findOne: jest.fn().mockResolvedValue(batch),
  } as unknown as jest.Mocked<Repository<AnalysisBatchEntity>>;

  const assetRepo = {
    findOne: jest.fn().mockResolvedValue(asset),
  } as unknown as jest.Mocked<Repository<AssetEntity>>;

  const farmJobRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue(farmJobs),
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as jest.Mocked<Repository<AnalysisFarmJobEntity>>;

  const farmJobId = randomUUID();
  const submitJobResult = overrides.submitJobResult ?? {
    job: { id: farmJobId, group_key: null },
  };
  const farmClient = {
    isConfigured: true,
    submitJob: jest.fn().mockResolvedValue({ ...submitJobResult, created: true }),
    controlJobs: jest.fn().mockResolvedValue(0),
    cancelJob: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<FarmClient>;

  const outboxService = {
    create: jest.fn().mockReturnValue({ eventType: 'asset.analysis.completed' }),
  } as unknown as jest.Mocked<OutboxService>;

  const analysisLog = {
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AnalysisLogService>;

  const managerMock = {
    findOne: jest.fn().mockResolvedValue(analysis),
    find: jest.fn().mockResolvedValue(farmJobs),
    update: jest.fn().mockResolvedValue(undefined),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as EntityManager;

  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (m: EntityManager) => Promise<unknown>) => fn(managerMock)),
    query: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DataSource>;

  const config = {
    get: (key: string) => {
      if (key === 'ANALYSIS_MODEL') return 'qwen2.5vl:7b';
      if (key === 'ANALYSIS_PROMPT_VERSION') return 'p2';
      return undefined;
    },
  } as unknown as ConfigService;

  const service = new AnalysisPipelineService(
    dataSource,
    analysisRepo,
    batchRepo,
    assetRepo,
    farmJobRepo,
    farmClient,
    outboxService,
    analysisLog,
    config,
  );

  return {
    service,
    analysisRepo,
    batchRepo,
    assetRepo,
    farmJobRepo,
    farmClient,
    outboxService,
    analysisLog,
    dataSource,
  };
}

// ---------------------------------------------------------------------------
// submitExtract
// ---------------------------------------------------------------------------

describe('submitExtract', () => {
  it('submits a scan.extract job to the farm for a queued analysis', async () => {
    const { service, farmClient } = makeService();
    await service.submitExtract(ANALYSIS_ID);
    expect(farmClient.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scan.extract', correlation_id: `${ANALYSIS_ID}:extract` }),
    );
  });

  it('marks the analysis as extracting after submission', async () => {
    const { service, analysisRepo } = makeService();
    await service.submitExtract(ANALYSIS_ID);
    expect(analysisRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: ANALYSIS_ID }),
      expect.objectContaining({ status: 'extracting' }),
    );
  });

  it('skips submission and returns when analysis is not queued', async () => {
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({ status: 'extracting' }),
    });
    await service.submitExtract(ANALYSIS_ID);
    expect(farmClient.submitJob).not.toHaveBeenCalled();
  });

  it('throws when farm client is not configured', async () => {
    const { service, farmClient } = makeService();
    Object.defineProperty(farmClient, 'isConfigured', { get: () => false });
    await expect(service.submitExtract(ANALYSIS_ID)).rejects.toThrow(/not configured/);
  });

  it('throws when analysis not found', async () => {
    const { service } = makeService({ analysis: null });
    await expect(service.submitExtract(ANALYSIS_ID)).rejects.toThrow(/not found/);
  });

  it('sets group_key to batch:<batchId> when analysis has a batch', async () => {
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({ status: 'queued', batchId: BATCH_ID }),
      batch: makeBatch({ status: 'running' }),
    });
    await service.submitExtract(ANALYSIS_ID);
    expect(farmClient.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ group_key: `batch:${BATCH_ID}` }),
    );
  });

  it('parks the analysis as paused when its batch is paused (holdForBatch)', async () => {
    const { service, farmClient, analysisRepo } = makeService({
      analysis: makeAnalysis({ status: 'queued', batchId: BATCH_ID }),
      batch: makeBatch({ status: 'paused' }),
    });
    await service.submitExtract(ANALYSIS_ID);
    expect(farmClient.submitJob).not.toHaveBeenCalled();
    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, { status: 'paused' });
  });

  it('parks the analysis as cancelled when its batch is cancelled', async () => {
    const { service, farmClient, analysisRepo } = makeService({
      analysis: makeAnalysis({ status: 'queued', batchId: BATCH_ID }),
      batch: makeBatch({ status: 'cancelled' }),
    });
    await service.submitExtract(ANALYSIS_ID);
    expect(farmClient.submitJob).not.toHaveBeenCalled();
    expect(analysisRepo.update).toHaveBeenCalledWith(
      ANALYSIS_ID,
      expect.objectContaining({ status: 'cancelled' }),
    );
  });
});

// ---------------------------------------------------------------------------
// submitAi
// ---------------------------------------------------------------------------

describe('submitAi', () => {
  const KEYFRAMES = [
    {
      output: 'keyframes/0000.jpg',
      t_ms: 100,
      width: 640,
      height: 360,
      dhash: '0123456789abcdef',
      scene_index: 0,
    },
  ];

  it('submits a scan.ai job for an extracted analysis', async () => {
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({
        status: 'extracted',
        keyframes: KEYFRAMES as unknown as Record<string, NonNullable<unknown>>[],
        durationMs: 5000,
        hasAudio: true,
      }),
    });
    await service.submitAi(ANALYSIS_ID);
    expect(farmClient.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scan.ai', correlation_id: `${ANALYSIS_ID}:ai` }),
    );
  });

  it('includes asset_name in the scan.ai payload context', async () => {
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({
        status: 'extracted',
        keyframes: KEYFRAMES as unknown as Record<string, NonNullable<unknown>>[],
        durationMs: 5000,
        hasAudio: true,
      }),
      asset: makeAsset({ originalFilename: 'my-clip.mp4' }),
    });
    await service.submitAi(ANALYSIS_ID);
    const payload = farmClient.submitJob.mock.calls[0]?.[0]?.payload as {
      context: { asset_name: string };
    };
    expect(payload.context.asset_name).toBe('my-clip.mp4');
  });

  it('submits with group_key = batch:<batchId> when analysis has a batch', async () => {
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({
        status: 'extracted',
        batchId: BATCH_ID,
        keyframes: KEYFRAMES as unknown as Record<string, NonNullable<unknown>>[],
        durationMs: 5000,
        hasAudio: true,
      }),
      batch: makeBatch({ status: 'running' }),
    });
    await service.submitAi(ANALYSIS_ID);
    expect(farmClient.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ group_key: `batch:${BATCH_ID}` }),
    );
  });

  it('does not submit when analysis status is not extracted or paused', async () => {
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({ status: 'describing' }),
    });
    const result = await service.submitAi(ANALYSIS_ID);
    expect(result).toBe(false);
    expect(farmClient.submitJob).not.toHaveBeenCalled();
  });

  it('sets analysis status to describing after submission', async () => {
    const { service, analysisRepo } = makeService({
      analysis: makeAnalysis({
        status: 'extracted',
        keyframes: KEYFRAMES as unknown as Record<string, NonNullable<unknown>>[],
        durationMs: 5000,
        hasAudio: true,
      }),
    });
    await service.submitAi(ANALYSIS_ID);
    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, { status: 'describing' });
  });

  it('returns false and parks as paused when batch is paused', async () => {
    const { service, farmClient, analysisRepo } = makeService({
      analysis: makeAnalysis({
        status: 'extracted',
        batchId: BATCH_ID,
        keyframes: KEYFRAMES as unknown as Record<string, NonNullable<unknown>>[],
        durationMs: 5000,
        hasAudio: true,
      }),
      batch: makeBatch({ status: 'paused' }),
    });
    const result = await service.submitAi(ANALYSIS_ID);
    expect(result).toBe(false);
    expect(farmClient.submitJob).not.toHaveBeenCalled();
    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, { status: 'paused' });
  });
});

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

describe('pause', () => {
  it('updates status to paused via query builder', async () => {
    const extractJobId = randomUUID();
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({ status: 'extracting' }),
      farmJobs: [makeFarmJob({ farmJobId: extractJobId, type: 'scan.extract', ingestedAt: null })],
    });
    const changed = await service.pause(ANALYSIS_ID);
    expect(changed).toBe(true);
    expect(farmClient.controlJobs).toHaveBeenCalledWith('pause', { ids: [extractJobId] });
  });

  it('returns false when the analysis is already finished', async () => {
    const { service } = makeService({ analysis: makeAnalysis({ status: 'completed' }) });
    // Make QB return affected=0
    const qb = (
      service['analysisRepo'] as jest.Mocked<Repository<AssetAnalysisEntity>>
    ).createQueryBuilder();
    (qb.execute as jest.Mock).mockResolvedValue({ affected: 0 });
    const changed = await service.pause(ANALYSIS_ID);
    expect(changed).toBe(false);
  });

  it('does not call farm when farm=false option is passed', async () => {
    const { service, farmClient } = makeService({
      farmJobs: [makeFarmJob({ ingestedAt: null })],
    });
    await service.pause(ANALYSIS_ID, { farm: false });
    expect(farmClient.controlJobs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

describe('resume', () => {
  it('returns false when analysis is not paused', async () => {
    const { service } = makeService({
      analysis: makeAnalysis({ status: 'extracting' }),
    });
    const changed = await service.resume(ANALYSIS_ID);
    expect(changed).toBe(false);
  });

  it('re-queues and submits extract when no extract job exists', async () => {
    const pausedAnalysis = makeAnalysis({ status: 'paused' });
    const { service, farmClient, analysisRepo } = makeService({
      analysis: pausedAnalysis,
      farmJobs: [], // no farm jobs at all
    });
    // submitExtract re-reads the analysis after update(); it must see status 'queued' or it skips.
    analysisRepo.findOne
      .mockResolvedValueOnce(pausedAnalysis) // resume(): initial status check
      .mockResolvedValueOnce(makeAnalysis({ status: 'queued' })); // submitExtract(): status gate
    const changed = await service.resume(ANALYSIS_ID);
    expect(changed).toBe(true);
    // submitExtract is called which submits a scan.extract job
    expect(farmClient.submitJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scan.extract' }),
    );
    // The analysis is re-queued first
    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, { status: 'queued' });
  });

  it('resumes extract at farm when extract is not yet ingested', async () => {
    const extractJobId = randomUUID();
    const { service, farmClient, analysisRepo } = makeService({
      analysis: makeAnalysis({ status: 'paused' }),
      farmJobs: [makeFarmJob({ farmJobId: extractJobId, type: 'scan.extract', ingestedAt: null })],
    });
    const changed = await service.resume(ANALYSIS_ID);
    expect(changed).toBe(true);
    expect(farmClient.controlJobs).toHaveBeenCalledWith('resume', { ids: [extractJobId] });
    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, { status: 'extracting' });
  });

  it('submits AI when extract is ingested but AI job does not exist yet', async () => {
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({
        status: 'paused',
        technical: {
          dead: false,
          brightness: 0.5,
          blur: 30,
          black_ratio: 0,
          frozen_ratio: 0,
          silence_ratio: null,
          has_speech_hint: null,
          dead_reason: null,
        },
        keyframes: [{ output: 'keyframes/0000.jpg', t_ms: 100 }] as unknown as Record<
          string,
          NonNullable<unknown>
        >[],
        durationMs: 5000,
        hasAudio: true,
      }),
      farmJobs: [makeFarmJob({ type: 'scan.extract', ingestedAt: new Date() })],
    });
    await service.resume(ANALYSIS_ID);
    expect(farmClient.submitJob).toHaveBeenCalledWith(expect.objectContaining({ type: 'scan.ai' }));
  });

  it('resumes AI at farm when AI job exists and is not ingested', async () => {
    const aiJobId = randomUUID();
    const { service, farmClient, analysisRepo } = makeService({
      analysis: makeAnalysis({
        status: 'paused',
        technical: { dead: false },
      }),
      farmJobs: [
        makeFarmJob({ type: 'scan.extract', ingestedAt: new Date() }),
        makeFarmJob({ farmJobId: aiJobId, type: 'scan.ai', ingestedAt: null }),
      ],
    });
    await service.resume(ANALYSIS_ID);
    expect(farmClient.controlJobs).toHaveBeenCalledWith('resume', { ids: [aiJobId] });
    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, { status: 'describing' });
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('cancels unfinished analysis and its pending farm jobs', async () => {
    const pendingJobId = randomUUID();
    const { service, farmClient } = makeService({
      analysis: makeAnalysis({ status: 'extracting' }),
      farmJobs: [makeFarmJob({ farmJobId: pendingJobId, type: 'scan.extract', ingestedAt: null })],
    });
    const changed = await service.cancel(ANALYSIS_ID, 'batch cancelled');
    expect(changed).toBe(true);
    expect(farmClient.controlJobs).toHaveBeenCalledWith('cancel', { ids: [pendingJobId] });
  });

  it('returns false when the analysis is already completed', async () => {
    const { service } = makeService({ analysis: makeAnalysis({ status: 'completed' }) });
    const qb = (
      service['analysisRepo'] as jest.Mocked<Repository<AssetAnalysisEntity>>
    ).createQueryBuilder();
    (qb.execute as jest.Mock).mockResolvedValue({ affected: 0 });
    const changed = await service.cancel(ANALYSIS_ID, 'test');
    expect(changed).toBe(false);
  });
});
