import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import type { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import type { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import type { AssetEntity } from '../../database/entities/asset.entity';
import type { StorageAdapter } from '../assets/storage/storage-adapter';
import type { SystemLogService } from '../logs/system-log.service';
import { AnalysisSignService } from './analysis-sign.service';
import type { SignOp } from './farm/sign';
import type { TicketClaims } from './farm/ticket';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));
jest.mock('../projects/project-asset-cleanup', () => ({
  assetVariantsPrefix: (key: string, id: string) => {
    const m = /^projects\/([^/]+)\//.exec(key);
    const prefix = m ? `projects/${m[1]}` : `assets/${id}`;
    return `${prefix}/variants/${id}/`;
  },
}));

// ---------------------------------------------------------------------------
// Fixed fixtures
// ---------------------------------------------------------------------------

const ASSET_ID = randomUUID();
const ANALYSIS_ID = randomUUID();
const FARM_JOB_ID = randomUUID();

const ASSET: AssetEntity = {
  id: ASSET_ID,
  assetType: 'video',
  originalFilename: 'clip.mp4',
  mimeType: 'video/mp4',
  checksumSha256: 'a'.repeat(64),
  fileSizeBytes: '102400',
  originalStorageKey: `projects/proj-1/originals/${ASSET_ID}/clip.mp4`,
  originalBucket: 'ag-go',
  storageProvider: 'r2',
  processingStatus: 'ready',
  sourceType: 'local',
  sourceMetadata: {},
  createdBy: 'test',
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as AssetEntity;

const ANALYSIS: AssetAnalysisEntity = {
  id: ANALYSIS_ID,
  assetId: ASSET_ID,
  status: 'extracting',
  reason: null,
  priority: 0,
  extractVersion: 'x1',
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
};

const EXTRACT_JOB: AnalysisFarmJobEntity = {
  farmJobId: FARM_JOB_ID,
  analysisId: ANALYSIS_ID,
  type: 'scan.extract',
  chunk: null,
  status: 'submitted',
  error: null,
  submittedAt: new Date(),
  ingestedAt: null,
  lockedUntil: null,
};

const AI_JOB: AnalysisFarmJobEntity = {
  ...EXTRACT_JOB,
  type: 'scan.ai',
  chunk: null,
};

/** The analysis prefix as computed by assetVariantsPrefix. */
const ANALYSIS_PREFIX = `projects/proj-1/variants/${ASSET_ID}/analysis/${ANALYSIS_ID}/`;

const CLAIMS: TicketClaims = {
  iss: 'ag-farm',
  sub: randomUUID(),
  jti: randomUUID(),
  job_id: FARM_JOB_ID,
  owner: 'ag-go',
  type: 'scan.extract',
  attempt: 1,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 300,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeService(
  overrides: {
    analysis?: AssetAnalysisEntity | null;
    asset?: AssetEntity | null;
    farmJob?: AnalysisFarmJobEntity | null;
    storage?: Partial<StorageAdapter>;
    ttl?: number;
  } = {},
): {
  service: AnalysisSignService;
  storage: jest.Mocked<StorageAdapter>;
  systemLog: jest.Mocked<SystemLogService>;
} {
  const {
    analysis = ANALYSIS,
    asset = ASSET,
    farmJob = EXTRACT_JOB,
    storage: storageOverrides = {},
    ttl = 3600,
  } = overrides;

  const analysisRepo = {
    findOne: jest.fn().mockResolvedValue(analysis),
  } as unknown as Repository<AssetAnalysisEntity>;

  const assetRepo = {
    findOne: jest.fn().mockResolvedValue(asset),
  } as unknown as Repository<AssetEntity>;

  const farmJobRepo = {
    findOne: jest.fn().mockResolvedValue(farmJob),
  } as unknown as Repository<AnalysisFarmJobEntity>;

  const defaultStorage: jest.Mocked<StorageAdapter> = {
    headObject: jest.fn().mockResolvedValue({ sizeBytes: 102400 }),
    getPresignedGetUrl: jest.fn().mockResolvedValue('https://cdn.example.com/get'),
    getPresignedPutUrl: jest.fn().mockResolvedValue('https://cdn.example.com/put'),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id-123'),
    getPresignedUploadPartUrl: jest.fn().mockResolvedValue('https://cdn.example.com/part'),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    getObjectText: jest.fn().mockResolvedValue(''),
    readObject: jest.fn(),
    putObject: jest.fn(),
    copyObject: jest.fn(),
    deleteObject: jest.fn(),
    deletePrefix: jest.fn(),
    listMultipartParts: jest.fn(),
  } as unknown as jest.Mocked<StorageAdapter>;

  Object.assign(defaultStorage, storageOverrides);

  const config = {
    get: jest.fn().mockReturnValue(ttl),
  } as unknown as ConfigService;

  const systemLog = {
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SystemLogService>;

  const service = new AnalysisSignService(
    analysisRepo,
    assetRepo,
    farmJobRepo,
    defaultStorage,
    config,
    systemLog,
  );

  return { service, storage: defaultStorage, systemLog };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalysisSignService', () => {
  describe('get source', () => {
    it('returns the original file URL with cache_key = checksum for scan.extract', async () => {
      const { service } = makeService();
      const ops: SignOp[] = [{ op: 'get', input: 'source' }];
      const response = await service.sign(CLAIMS, EXTRACT_JOB, ops);

      expect(response.results).toHaveLength(1);
      const result = response.results[0];
      expect(result.op).toBe('get');
      if (result.op === 'get') {
        expect(result.cache_key).toBe(ASSET.checksumSha256);
        expect(result.source?.watermarked).toBe(false);
        expect(result.source?.source_kind).toBe('original');
        expect(result.url).toBe('https://cdn.example.com/get');
      }
    });

    it('uses assetId:size as cache_key when checksum is null', async () => {
      const assetNoChecksum = { ...ASSET, checksumSha256: null };
      const { service } = makeService({ asset: assetNoChecksum });
      const response = await service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'source' }]);
      const result = response.results[0];
      if (result.op === 'get') {
        expect(result.cache_key).toBe(`${ASSET_ID}:${ASSET.fileSizeBytes}`);
      }
    });

    it('rejects get source for scan.ai jobs', async () => {
      const { service } = makeService();
      await expect(service.sign(CLAIMS, AI_JOB, [{ op: 'get', input: 'source' }])).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('get artifact:<path>', () => {
    it('signs a read under the analysis prefix', async () => {
      const { service, storage } = makeService();
      const path = 'keyframes/seg-0-frame-0.jpg';
      const response = await service.sign(CLAIMS, EXTRACT_JOB, [
        { op: 'get', input: `artifact:${path}` },
      ]);
      expect(storage.getPresignedGetUrl).toHaveBeenCalledWith(
        `${ANALYSIS_PREFIX}${path}`,
        expect.any(String),
        3600,
      );
      expect(response.results[0].op).toBe('get');
    });

    it('rejects traversal paths (../)', async () => {
      const { service } = makeService();
      await expect(
        service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'artifact:../secret' }]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects paths with double slash (a//b)', async () => {
      const { service } = makeService();
      await expect(
        service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'artifact:a//b' }]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects paths with dot segment (./a)', async () => {
      const { service } = makeService();
      await expect(
        service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'artifact:./a' }]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects paths with backslash', async () => {
      const { service } = makeService();
      await expect(
        service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'artifact:a\\b' }]),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('put / write ops', () => {
    it('signs a put under the analysis prefix', async () => {
      const { service, storage } = makeService();
      const response = await service.sign(CLAIMS, EXTRACT_JOB, [
        { op: 'put', output: 'extract.json', content_type: 'application/json' },
      ]);
      expect(storage.getPresignedPutUrl).toHaveBeenCalledWith(
        `${ANALYSIS_PREFIX}extract.json`,
        'application/json',
        3600,
      );
      expect(response.results[0].op).toBe('put');
    });

    it('rejects traversal in the output path', async () => {
      const { service } = makeService();
      await expect(
        service.sign(CLAIMS, EXTRACT_JOB, [
          { op: 'put', output: '../other-analysis/payload.json', content_type: 'application/json' },
        ]),
      ).rejects.toThrow(ForbiddenException);
    });

    it('scan.ai jobs may only write ai.json', async () => {
      const { service } = makeService();

      const response = await service.sign(CLAIMS, AI_JOB, [
        { op: 'put', output: 'ai.json', content_type: 'application/json' },
      ]);
      expect(response.results[0].op).toBe('put');
    });

    it('scan.ai jobs may write ai-trace.json', async () => {
      const { service } = makeService();
      const response = await service.sign(CLAIMS, AI_JOB, [
        { op: 'put', output: 'ai-trace.json', content_type: 'application/json' },
      ]);
      expect(response.results[0].op).toBe('put');
    });

    it('scan.ai jobs cannot write any other output (not ai.json or ai-trace.json)', async () => {
      const { service } = makeService();
      await expect(
        service.sign(CLAIMS, AI_JOB, [
          { op: 'put', output: 'ai-0000.json', content_type: 'application/json' },
        ]),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('multipart ops', () => {
    it('creates a multipart upload under the analysis prefix', async () => {
      const { service, storage } = makeService();
      const response = await service.sign(CLAIMS, EXTRACT_JOB, [
        { op: 'mp_create', output: 'proxy.mp4', content_type: 'video/mp4' },
      ]);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith(
        `${ANALYSIS_PREFIX}proxy.mp4`,
        'video/mp4',
      );
      expect(response.results[0]).toMatchObject({ op: 'mp_create', output: 'proxy.mp4' });
    });

    it('does not call createMultipartUpload when a later op in the batch is forbidden', async () => {
      const { service, storage } = makeService();
      const ops: SignOp[] = [
        { op: 'mp_create', output: 'proxy.mp4', content_type: 'video/mp4' },
        // scan.extract job cannot write ai-0000.json (wrong job type restriction not here,
        // but traversal is always forbidden regardless of job type)
        { op: 'put', output: '../escape.json', content_type: 'application/json' },
      ];
      await expect(service.sign(CLAIMS, EXTRACT_JOB, ops)).rejects.toThrow(ForbiddenException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('audit', () => {
    it('writes a system log entry after successful signing', async () => {
      const { service, systemLog } = makeService();
      await service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'source' }]);
      expect(systemLog.write).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'info',
          category: 'farm_sign',
          action: 'farm.sign',
        }),
      );
    });
  });

  describe('error cases', () => {
    it('throws 404 when the analysis record is missing', async () => {
      const { service } = makeService({ analysis: null });
      await expect(
        service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'source' }]),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws 404 when the asset record is missing', async () => {
      const { service } = makeService({ asset: null });
      await expect(
        service.sign(CLAIMS, EXTRACT_JOB, [{ op: 'get', input: 'source' }]),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
