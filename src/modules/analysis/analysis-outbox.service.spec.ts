import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import type { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import type { AssetEntity } from '../../database/entities/asset.entity';
import type { AnalysisLogService } from './analysis-log.service';
import { AnalysisOutboxService } from './analysis-outbox.service';
import type { AnalysisPipelineService } from './analysis-pipeline.service';

// uuid v14 is pure-ESM; mock it so Jest (CommonJS) can load the service under test.
jest.mock('uuid', () => {
  let n = 0;
  return { v7: () => `00000000-0000-7000-0000-${String(++n).padStart(12, '0')}` };
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
  sourceMetadata: { durationSeconds: 15.5, width: 1920, height: 1080 },
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
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
} as unknown as AssetAnalysisEntity;

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

function makeService(overrides: {
  analysis?: AssetAnalysisEntity | null;
  asset?: AssetEntity | null;
  submitExtract?: jest.Mock;
}) {
  const {
    analysis = STUB_ANALYSIS,
    asset = STUB_ASSET,
    submitExtract = jest.fn().mockResolvedValue(undefined),
  } = overrides;

  const analysisRepo = {
    findOne: jest.fn().mockResolvedValue(analysis),
    update: jest.fn().mockResolvedValue(undefined),
  } as unknown as Repository<AssetAnalysisEntity>;

  const assetRepo = {
    findOne: jest.fn().mockResolvedValue(asset),
  } as unknown as Repository<AssetEntity>;

  const pipeline = {
    submitExtract,
  } as unknown as AnalysisPipelineService;

  const analysisLog = {
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AnalysisLogService>;

  const service = new AnalysisOutboxService(analysisRepo, assetRepo, pipeline, analysisLog);

  return { service, analysisRepo, assetRepo, pipeline, submitExtract, analysisLog };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalysisOutboxService.handleAnalysisRequested', () => {
  it('calls pipeline.submitExtract with the analysis id', async () => {
    const { service, submitExtract } = makeService({});
    await service.handleAnalysisRequested(ANALYSIS_ID);
    expect(submitExtract).toHaveBeenCalledWith(ANALYSIS_ID);
  });

  it('resolves without error when submitExtract succeeds', async () => {
    const { service } = makeService({});
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).resolves.toBeUndefined();
  });

  it('keeps a submit error on the queued analysis and logs it', async () => {
    const submitExtract = jest.fn().mockRejectedValue(new Error('farm unreachable'));
    const { service, analysisRepo, analysisLog } = makeService({ submitExtract });
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).rejects.toThrow(/unreachable/);

    expect(analysisRepo.update).toHaveBeenCalledWith(ANALYSIS_ID, {
      reason: 'Could not submit to the farm: farm unreachable',
    });
    expect(analysisLog.write).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', action: 'analysis.extract.submit_failed' }),
    );
  });

  it('does not log a retry that fails with the same error again', async () => {
    const submitExtract = jest.fn().mockRejectedValue(new Error('farm unreachable'));
    const { service, analysisRepo, analysisLog } = makeService({
      submitExtract,
      analysis: { ...STUB_ANALYSIS, reason: 'Could not submit to the farm: farm unreachable' },
    });
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).rejects.toThrow(/unreachable/);

    expect(analysisRepo.update).not.toHaveBeenCalled();
    expect(analysisLog.write).not.toHaveBeenCalled();
  });

  it('rethrows the error from submitExtract', async () => {
    const submitExtract = jest.fn().mockRejectedValue(new Error('FARM_URL is not configured'));
    const { service } = makeService({ submitExtract });
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).rejects.toThrow(
      /FARM_URL is not configured/,
    );
  });

  it('logs submit failure with the asset filename when analysis row exists', async () => {
    const submitExtract = jest.fn().mockRejectedValue(new Error('network error'));
    const { service, analysisLog } = makeService({ submitExtract });
    await expect(service.handleAnalysisRequested(ANALYSIS_ID)).rejects.toThrow();

    expect(analysisLog.write).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        action: 'analysis.extract.submit_failed',
        metadata: expect.objectContaining({ analysisId: ANALYSIS_ID, assetId: ASSET_ID }),
      }),
    );
  });
});
