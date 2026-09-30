/**
 * Unit tests for FarmResultPollerService.
 *
 * These tests focus on the control-flow paths: unknown / adopt / ingested / lock-busy, ack
 * decisions in poll(), and the overlapping-poll guard. Full ingestion logic (extract manifest
 * parsing, AI manifest parsing, finalize) is covered by farm-result-poller.db-spec.ts.
 *
 * Only the farm client and storage adapter are given to the service; all TypeORM repos are plain
 * jest mocks so we never hit a real database.
 */
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { DataSource, Repository } from 'typeorm';
import type { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import type { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import type { AssetEntity } from '../../database/entities/asset.entity';
import type { StorageAdapter } from '../assets/storage/storage-adapter';
import type { AnalysisLogService } from './analysis-log.service';
import type { AnalysisPipelineService } from './analysis-pipeline.service';
import { FarmResultPollerService } from './farm-result-poller.service';
import type { FarmClient } from './farm/farm-client';
import type { JobView } from './farm/protocol';

// uuid v14 is pure-ESM; mock it so Jest (CommonJS) can load the service under test.
jest.mock('uuid', () => {
  let n = 0;
  return { v7: () => `00000000-0000-7000-0000-${String(++n).padStart(12, '0')}` };
});

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
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
// Fixtures
// ---------------------------------------------------------------------------

const FARM_JOB_ID = randomUUID();
const ANALYSIS_ID = randomUUID();

const EXTRACT_FARM_JOB: AnalysisFarmJobEntity = {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a minimal JobView suitable for unit tests. */
function makeJobView(overrides: Partial<JobView> = {}): JobView {
  return {
    id: FARM_JOB_ID,
    owner: 'ag-go',
    type: 'scan.extract',
    lane: 'batch',
    status: 'completed',
    priority: 0,
    correlation_id: `${ANALYSIS_ID}:extract`,
    affinity_key: ANALYSIS_ID,
    group_key: null,
    attempt_count: 1,
    max_attempts: 3,
    node_id: null,
    progress_percent: null,
    progress_stage: null,
    result: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    acked_at: null,
    ...overrides,
  };
}

/**
 * Builds a FarmResultPollerService with every TypeORM dependency mocked.
 *
 * @param farmJobFindOneValues  Sequence returned by farmJobRepo.findOne (cycles on last item).
 * @param lockAffected          Affected-rows count returned by the UPDATE that acquires a lock.
 * @param analysisCount         Value returned by analysisRepo.count (used in adoption path).
 * @param farmClientListResult  Jobs returned by farmClient.listUnackedFinished.
 */
function makeService(
  options: {
    farmJobFindOneValues?: Array<AnalysisFarmJobEntity | null>;
    lockAffected?: number;
    analysisCount?: number;
    farmClientListResult?: JobView[];
  } = {},
) {
  const {
    farmJobFindOneValues = [EXTRACT_FARM_JOB],
    lockAffected = 1,
    analysisCount = 1,
    farmClientListResult = [],
  } = options;

  let findOneCallIdx = 0;

  const farmJobRepo = {
    findOne: jest.fn().mockImplementation(() => {
      const idx = Math.min(findOneCallIdx, farmJobFindOneValues.length - 1);
      findOneCallIdx++;
      return Promise.resolve(farmJobFindOneValues[idx] ?? null);
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: lockAffected }),
    }),
  };

  const analysisRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    count: jest.fn().mockResolvedValue(analysisCount),
  };

  const assetRepo = {
    findOne: jest.fn().mockResolvedValue(null),
  };

  const manager = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockReturnValue({}),
  };

  const dataSource = {
    transaction: jest
      .fn()
      .mockImplementation((cb: (mgr: typeof manager) => Promise<unknown>) => cb(manager)),
    query: jest.fn().mockResolvedValue([]),
    manager: { update: jest.fn().mockResolvedValue({ affected: 0 }) },
  };

  const storage = {
    getObjectText: jest
      .fn()
      .mockRejectedValue(new Error('getObjectText should not be called in this test')),
  };

  const farmClient = {
    isConfigured: true,
    submitJob: jest.fn().mockResolvedValue({ job: { id: randomUUID() } }),
    listUnackedFinished: jest.fn().mockResolvedValue(farmClientListResult),
    ackJob: jest.fn().mockResolvedValue(undefined),
    cancelJob: jest.fn().mockResolvedValue(undefined),
  };

  const pipeline = {
    submitAi: jest.fn().mockResolvedValue(true),
    finalizeIfDone: jest.fn().mockResolvedValue(undefined),
    recordFarmJob: jest.fn().mockResolvedValue(undefined),
  };

  const config = {
    get: jest.fn().mockReturnValue(undefined),
  };

  const analysisLog = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new FarmResultPollerService(
    dataSource as unknown as DataSource,
    analysisRepo as unknown as Repository<AssetAnalysisEntity>,
    assetRepo as unknown as Repository<AssetEntity>,
    farmJobRepo as unknown as Repository<AnalysisFarmJobEntity>,
    storage as unknown as StorageAdapter,
    farmClient as unknown as FarmClient,
    pipeline as unknown as AnalysisPipelineService,
    analysisLog as unknown as AnalysisLogService,
    config as unknown as ConfigService,
  );

  return {
    service,
    farmJobRepo,
    analysisRepo,
    farmClient,
    storage,
    analysisLog,
    pipeline,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FarmResultPollerService', () => {
  // -------------------------------------------------------------------------
  // processJob: unknown farm job
  // -------------------------------------------------------------------------

  describe('processJob: unknown farm job', () => {
    it('returns true (ack) when the correlation_id does not match the pattern', async () => {
      const { service } = makeService({
        farmJobFindOneValues: [null],
        analysisCount: 0,
      });
      const result = await service.processJob(
        makeJobView({ id: randomUUID(), correlation_id: 'not-a-valid-correlation-id' }),
      );
      expect(result).toBe(true);
    });

    it('returns true (ack) when the correlation_id matches but the analysis does not exist', async () => {
      const ghostAnalysisId = randomUUID();
      const { service } = makeService({
        farmJobFindOneValues: [null],
        analysisCount: 0, // analysis repo returns count 0
      });
      const result = await service.processJob(
        makeJobView({ id: randomUUID(), correlation_id: `${ghostAnalysisId}:extract` }),
      );
      expect(result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // processJob: adopt from correlation_id
  // -------------------------------------------------------------------------

  describe('processJob: adopt from correlation_id', () => {
    it('delegates to pipeline.recordFarmJob when the job is found only by correlation_id', async () => {
      // The first findOne returns null (row not found), the second returns an already-ingested row
      // so the test terminates quickly without needing the full processing stack.
      const adoptedRow: AnalysisFarmJobEntity = {
        ...EXTRACT_FARM_JOB,
        farmJobId: randomUUID(),
        ingestedAt: new Date(),
        lockedUntil: null,
      };
      const { service, pipeline } = makeService({
        farmJobFindOneValues: [null, adoptedRow],
        analysisCount: 1,
      });

      const result = await service.processJob(
        makeJobView({ id: adoptedRow.farmJobId, correlation_id: `${ANALYSIS_ID}:extract` }),
      );

      expect(result).toBe(true);
      // Adoption path now delegates to AnalysisPipelineService.recordFarmJob
      expect(pipeline.recordFarmJob).toHaveBeenCalledWith(
        adoptedRow.farmJobId,
        ANALYSIS_ID,
        'scan.extract',
      );
    });
  });

  // -------------------------------------------------------------------------
  // processJob: already ingested
  // -------------------------------------------------------------------------

  describe('processJob: already ingested', () => {
    it('returns true immediately without reading storage', async () => {
      const ingestedRow: AnalysisFarmJobEntity = {
        ...EXTRACT_FARM_JOB,
        ingestedAt: new Date(),
      };
      const { service, storage } = makeService({ farmJobFindOneValues: [ingestedRow] });
      const result = await service.processJob(makeJobView());
      expect(result).toBe(true);
      expect(storage.getObjectText).not.toHaveBeenCalled();
    });

    it('does not acquire a lock for an already-ingested row', async () => {
      const ingestedRow: AnalysisFarmJobEntity = {
        ...EXTRACT_FARM_JOB,
        ingestedAt: new Date(),
      };
      const { service, farmJobRepo } = makeService({ farmJobFindOneValues: [ingestedRow] });
      await service.processJob(makeJobView());
      // The lock UPDATE goes through createQueryBuilder — must not be called
      expect(farmJobRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // processJob: lock busy
  // -------------------------------------------------------------------------

  describe('processJob: lock busy', () => {
    it('returns false when another host holds the lock (affected rows = 0)', async () => {
      const { service } = makeService({ lockAffected: 0 });
      const result = await service.processJob(makeJobView());
      expect(result).toBe(false);
    });

    it('does not read storage when the lock cannot be acquired', async () => {
      const { service, storage } = makeService({ lockAffected: 0 });
      await service.processJob(makeJobView());
      expect(storage.getObjectText).not.toHaveBeenCalled();
    });

    it('does not release a lock it never acquired', async () => {
      const { service, farmJobRepo } = makeService({ lockAffected: 0 });
      await service.processJob(makeJobView());
      // farmJobRepo.update is called only in the finally block (lock release)
      expect(farmJobRepo.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // poll: ack decisions
  // -------------------------------------------------------------------------

  describe('poll: ack decisions', () => {
    it('acks a job when processJob returns true', async () => {
      const job = makeJobView();
      const { service, farmClient } = makeService({ farmClientListResult: [job] });
      jest.spyOn(service, 'processJob').mockResolvedValue(true);
      await service.poll();
      expect(farmClient.ackJob).toHaveBeenCalledWith(job.id);
    });

    it('does not ack a job when processJob returns false', async () => {
      const job = makeJobView();
      const { service, farmClient } = makeService({ farmClientListResult: [job] });
      jest.spyOn(service, 'processJob').mockResolvedValue(false);
      await service.poll();
      expect(farmClient.ackJob).not.toHaveBeenCalled();
    });

    it('does not ack a job when processJob throws', async () => {
      const job = makeJobView();
      const { service, farmClient } = makeService({ farmClientListResult: [job] });
      jest.spyOn(service, 'processJob').mockRejectedValue(new Error('transient failure'));
      await service.poll();
      expect(farmClient.ackJob).not.toHaveBeenCalled();
    });

    it('does not throw when processJob throws (other jobs still processed)', async () => {
      const job1 = makeJobView({ id: randomUUID() });
      const job2 = makeJobView({ id: randomUUID() });
      const { service, farmClient } = makeService({ farmClientListResult: [job1, job2] });
      jest
        .spyOn(service, 'processJob')
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValueOnce(true);
      await expect(service.poll()).resolves.toBeUndefined();
      expect(farmClient.ackJob).toHaveBeenCalledWith(job2.id);
      expect(farmClient.ackJob).not.toHaveBeenCalledWith(job1.id);
    });
  });

  // -------------------------------------------------------------------------
  // poll: processing log
  // -------------------------------------------------------------------------

  describe('poll: processing log', () => {
    it('logs a failing result once per error text, not on every poll', async () => {
      const job = makeJobView();
      const { service, analysisLog } = makeService({ farmClientListResult: [job] });
      const processJob = jest.spyOn(service, 'processJob');
      processJob.mockRejectedValue(new Error('storage down'));
      await service.poll();
      await service.poll();
      expect(analysisLog.write).toHaveBeenCalledTimes(1);
      expect(analysisLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error', action: 'analysis.ingest_failed' }),
      );

      processJob.mockRejectedValue(new Error('manifest invalid'));
      await service.poll();
      expect(analysisLog.write).toHaveBeenCalledTimes(2);
    });

    it('logs the same error again after the job has succeeded in between', async () => {
      const job = makeJobView();
      const { service, analysisLog } = makeService({ farmClientListResult: [job] });
      jest
        .spyOn(service, 'processJob')
        .mockRejectedValueOnce(new Error('storage down'))
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('storage down'));
      await service.poll();
      await service.poll();
      await service.poll();
      expect(analysisLog.write).toHaveBeenCalledTimes(2);
    });

    it('logs a failing farm poll once until it recovers', async () => {
      const { service, farmClient, analysisLog } = makeService();
      const list = farmClient.listUnackedFinished as jest.Mock;
      list.mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'));
      await service.poll();
      await service.poll();
      expect(analysisLog.write).toHaveBeenCalledTimes(1);
      expect(analysisLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error', action: 'analysis.poll_failed' }),
      );

      await service.poll(); // recovers
      list.mockRejectedValueOnce(new Error('network'));
      await service.poll();
      expect(analysisLog.write).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // poll: overlapping poll guard
  // -------------------------------------------------------------------------

  describe('poll: overlapping poll guard', () => {
    it('skips listing jobs when the previous poll is still running', async () => {
      const { service, farmClient } = makeService();
      // Simulate a poll that has not finished yet
      (service as unknown as { polling: boolean }).polling = true;
      await service.poll();
      expect(farmClient.listUnackedFinished).not.toHaveBeenCalled();
    });

    it('resets the polling flag even when listUnackedFinished throws', async () => {
      const { service, farmClient } = makeService();
      (farmClient.listUnackedFinished as jest.Mock).mockRejectedValueOnce(new Error('network'));
      await expect(service.poll()).resolves.toBeUndefined();
      // After the failed poll the flag must be reset so the next poll can run
      expect((service as unknown as { polling: boolean }).polling).toBe(false);
    });
  });
});
