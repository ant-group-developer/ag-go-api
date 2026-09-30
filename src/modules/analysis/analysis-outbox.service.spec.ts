import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import type { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import type { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import type { AssetEntity } from '../../database/entities/asset.entity';
import { AnalysisOutboxService } from './analysis-outbox.service';
import type { FarmClient } from './farm/farm-client';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ASSET_ID = randomUUID();
const ANALYSIS_ID = randomUUID();

const STUB_ASSET: AssetEntity = {
  id: ASSET_ID,
  assetType: 'video',
  originalFilename: 'clip.mp4',
  mimeType: 'video/mp4',
  checksumSha256: 'b'.repeat(64),
  fileSizeBytes: '204800',
  originalStorageKey: `projects/p1/originals/${ASSET_ID}/clip.mp4`,
  originalBucket: 'ag-go',
  storageProvider: 'r2',
  processingStatus: 'ready',
  sourceType: 'local',
  sourceMetadata: {
    durationSeconds: 15.5,
    width: 1920,
    height: 1080,
  },
  createdBy: 'test',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as AssetEntity;

const STUB_ANALYSIS: AssetAnalysisEntity = {
  id: ANALYSIS_ID,
  assetId: ASSET_ID,
  status: 'queued',
  reason: null,
  priority: 3,
  extractVersion: 'x2',
  promptVersion: 'p1',
  models: null,
  artifacts: null,
  summary: null,
  isCurrent: false,
  requestedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
};

const FARM_JOB_RESPONSE = {
  job: { id: randomUUID(), status: 'queued', type: 'scan.extract' },
};

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

function makeService(overrides: {
  analysis?: AssetAnalysisEntity | null;
  asset?: AssetEntity | null;
  isConfigured?: boolean;
  submitJob?: jest.Mock;
  extractVersion?: string;
}) {
  const {
    analysis = STUB_ANALYSIS,
    asset = STUB_ASSET,
    isConfigured = true,
    submitJob = jest.fn().mockResolvedValue(FARM_JOB_RESPONSE),
    extractVersion = 'x2',
  } = overrides;

  const analysisRepo = {
    findOne: jest.fn().mockResolvedValue(analysis),
    update: jest.fn().mockResolvedValue(undefined),
  } as unknown as Repository<AssetAnalysisEntity>;

  const assetRepo = {
    findOne: jest.fn().mockResolvedValue(asset),
  } as unknown as Repository<AssetEntity>;

  const farmJobRepo = {
    create: jest.fn((data: Partial<AnalysisFarmJobEntity>) => data),
    save: jest.fn().mockResolvedValue(undefined),
  } as unknown as Repository<AnalysisFarmJobEntity>;

  const farmClient = {
    isConfigured,
    submitJob,
  } as unknown as FarmClient;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ANALYSIS_EXTRACT_VERSION') return extractVersion;
      return undefined;
    }),
  } as unknown as ConfigService;

  const service = new AnalysisOutboxService(
    analysisRepo,
    assetRepo,
    farmJobRepo,
    farmClient,
    config,
  );

  return { service, analysisRepo, assetRepo, farmJobRepo, submitJob };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalysisOutboxService.handleAnalysisRequested', () => {
  it('submits a scan.extract job with correlation_id = <analysisId>:extract', async () => {
    const { service, submitJob } = makeService({});
    await service.handleAnalysisRequested(ANALYSIS_ID);

    expect(submitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scan.extract',
        correlation_id: `${ANALYSIS_ID}:extract`,
      }),
    );
  });

  it('sets priority from the analysis record', async () => {
    const { service, submitJob } = makeService({});
    await service.handleAnalysisRequested(ANALYSIS_ID);

    expect(submitJob).toHaveBeenCalledWith(expect.objectContaining({ priority: 3 }));
  });

  it('includes correct asset kind "video" for video mime type', async () => {
    const { service, submitJob } = makeService({});
    await service.handleAnalysisRequested(ANALYSIS_ID);

    const [req] = submitJob.mock.calls[0] as [{ payload: { asset: { kind: string } } }];
    expect(req.payload.asset.kind).toBe('video');
  });

  it('includes correct asset kind "image" for image mime type', async () => {
    const imageAsset = {
      ...STUB_ASSET,
      assetType: 'image' as const,
      mimeType: 'image/jpeg',
      sourceMetadata: { width: 800, height: 600 },
    };
    const { service, submitJob } = makeService({ asset: imageAsset });
    await service.handleAnalysisRequested(ANALYSIS_ID);

    const [req] = submitJob.mock.calls[0] as [{ payload: { asset: { kind: string } } }];
    expect(req.payload.asset.kind).toBe('image');
  });

  it('includes extract_version from the analysis record', async () => {
    const { service, submitJob } = makeService({ extractVersion: 'x2' });
    await service.handleAnalysisRequested(ANALYSIS_ID);

    const [req] = submitJob.mock.calls[0] as [{ payload: { extract_version: string } }];
    expect(req.payload.extract_version).toBe('x2');
  });

  it('records a farm job row with type scan.extract', async () => {
    const { service, farmJobRepo } = makeService({});
    await service.handleAnalysisRequested(ANALYSIS_ID);

    expect(farmJobRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scan.extract', analysisId: ANALYSIS_ID }),
    );
  });

  it('sets the analysis status to "extracting"', async () => {
    const { service, analysisRepo } = makeService({});
    await service.handleAnalysisRequested(ANALYSIS_ID);

    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, { status: 'extracting' });
  });

  it('throws when FARM_URL is not configured', async () => {
    const { service } = makeService({ isConfigured: false });
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).rejects.toThrow(/FARM_URL/);
  });

  it('throws when the analysis row is not found', async () => {
    const { service } = makeService({ analysis: null });
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).rejects.toThrow(/not found/);
  });

  it('throws when the asset row is not found', async () => {
    const { service } = makeService({ asset: null });
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).rejects.toThrow(/not found/);
  });

  it('converts durationSeconds from sourceMetadata to duration_ms', async () => {
    const { service, submitJob } = makeService({});
    await service.handleAnalysisRequested(ANALYSIS_ID);

    const [req] = submitJob.mock.calls[0] as [{ payload: { asset: { duration_ms: number } } }];
    // 15.5 s → 15500 ms (rounded)
    expect(req.payload.asset.duration_ms).toBe(15500);
  });
});
