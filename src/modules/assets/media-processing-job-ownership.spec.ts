import type { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { MediaProcessingService } from './media-processing.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));
// A new value per call, so a token reused across claims would show.
jest.mock('uuid', () => {
  let count = 0;
  return { v7: () => `uuid-${(count += 1)}` };
});

/**
 * With media workers on several hosts, a render job must only be written by the worker run
 * that holds it, and "stale" must be judged on the database clock, not a host's own clock.
 */
describe('MediaProcessingService job ownership', () => {
  const job = { id: 'job-1', assetId: 'asset-1', renderProfileId: null, renderBatchId: null };
  const heldBy = (claimToken: string) => ({ id: job.id, status: 'processing', claimToken });
  const assetMarkedFailed = expect.objectContaining({ processingStatus: 'failed' });

  function queryBuilderChain() {
    return {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    };
  }

  function createRender({
    currentJob = heldBy,
    finalWriteAffected = 1,
    render = 'succeeds',
  }: {
    /** What the ownership checks read back for the token of the latest claim. */
    currentJob?: (claimToken: string) => unknown;
    /** Rows the owner-scoped job write of the final (completed/failed) transaction matches. */
    finalWriteAffected?: number;
    render?: 'succeeds' | 'fails';
  } = {}) {
    const chain = queryBuilderChain();
    const claimToken = () =>
      (chain.set.mock.calls.at(-1) as unknown as [{ claimToken: string }])[0].claimToken;
    const transactionManager = {
      update: jest.fn().mockResolvedValue({ affected: finalWriteAffected }),
    };
    const jobRepository = {
      findOne: jest.fn(async (options: { select?: unknown }) =>
        options.select ? currentJob(claimToken()) : job,
      ),
      createQueryBuilder: () => chain,
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: (work: (manager: unknown) => Promise<unknown>) => work(transactionManager),
      },
    };
    const assetRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'asset-1',
        assetType: 'video',
        originalStorageKey: 'projects/p1/originals/a.mp4',
      }),
      update: jest.fn(),
    };
    const service = new MediaProcessingService(
      assetRepository as never,
      {} as never,
      jobRepository as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      {
        headObject: jest.fn().mockResolvedValue({}),
        readObject: jest.fn(() => Readable.from([Buffer.from('source')])),
      } as never,
      { getOrThrow: () => 600 } as unknown as ConfigService,
    );
    const processVideo = jest.spyOn(
      service as unknown as {
        processVideo: (...args: unknown[]) => Promise<Record<string, unknown>>;
      },
      'processVideo',
    );
    if (render === 'fails') {
      processVideo.mockRejectedValue(new Error('FFmpeg exited with code 1'));
    } else {
      processVideo.mockImplementation(async (...args: unknown[]) => {
        const report = args[3] as (percent: number, message: string) => Promise<void>;
        await report(50, 'Rendering previews');
        return { width: 1280, height: 720 };
      });
    }
    return { service, chain, claimToken, jobRepository, assetRepository, transactionManager };
  }

  it('judges stale jobs on the database clock and clears their claim token', async () => {
    const chain = queryBuilderChain();
    const service = new MediaProcessingService(
      {} as never,
      {} as never,
      { createQueryBuilder: () => chain } as never,
      {} as never,
      {} as never,
      { getOrThrow: () => 3 } as unknown as ConfigService,
    );

    await expect(service.recoverStaleJobs()).resolves.toEqual([]);

    // Both sweeps: the exhausted jobs that fail, and the rest that go back to the queue.
    expect(chain.where).toHaveBeenCalledTimes(2);
    for (const [sql, params] of chain.where.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >) {
      expect(sql).toContain('updated_at < NOW() - CAST(:staleAfter AS interval)');
      expect(params.staleAfter).toBe('180000 milliseconds');
      // A timestamp computed on this host would compare its clock with the database's.
      expect(Object.values(params).some((value) => value instanceof Date)).toBe(false);
    }
    for (const [values] of chain.set.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(values).toMatchObject({ claimToken: null });
    }
  });

  it('claims with a fresh token each time and scopes every job write to it', async () => {
    const { service, chain, claimToken, jobRepository, transactionManager } = createRender();

    await service.processJobById(job.id, job.assetId);
    const firstToken = claimToken();
    await service.processJobById(job.id, job.assetId);
    expect(claimToken()).not.toBe(firstToken);

    const owned = heldBy(claimToken());
    expect(jobRepository.update).toHaveBeenCalledWith(owned, {
      progressPercent: 50,
      progressMessage: 'Rendering previews',
    });
    expect(transactionManager.update).toHaveBeenCalledWith(
      MediaRenderJobEntity,
      owned,
      expect.objectContaining({ status: 'completed' }),
    );
    expect(transactionManager.update).toHaveBeenCalledWith(
      AssetEntity,
      'asset-1',
      expect.objectContaining({ processingStatus: 'ready' }),
    );

    // The heartbeat keeps only this run's claim alive.
    chain.where.mockClear();
    await (service as unknown as { touchJob: (render: unknown) => Promise<void> }).touchJob({
      jobId: job.id,
      claimToken: claimToken(),
    });
    expect(chain.where).toHaveBeenCalledWith(
      expect.stringContaining('claim_token = :claimToken'),
      owned,
    );
  });

  it.each([
    ['deleted with its asset', () => null],
    ['claimed by another worker', () => heldBy('other-worker-token')],
  ])('leaves the asset alone when its job was %s before rendering', async (_, currentJob) => {
    const { service, assetRepository, transactionManager } = createRender({ currentJob });

    await expect(service.processJobById(job.id, job.assetId)).resolves.toBeUndefined();

    expect(assetRepository.update).not.toHaveBeenCalled();
    expect(transactionManager.update).not.toHaveBeenCalled();
  });

  it('does not mark the asset ready when it lost the job right before completing', async () => {
    const { service, transactionManager } = createRender({ finalWriteAffected: 0 });

    await expect(service.processJobById(job.id, job.assetId)).resolves.toBeUndefined();

    expect(transactionManager.update).toHaveBeenCalledTimes(1);
    expect(transactionManager.update).not.toHaveBeenCalledWith(
      AssetEntity,
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails for a retry instead of writing when it cannot confirm it holds the job', async () => {
    const { service, assetRepository } = createRender({
      currentJob: () => {
        throw new Error('Connection terminated unexpectedly');
      },
    });

    await expect(service.processJobById(job.id, job.assetId)).rejects.toThrow(
      'Connection terminated unexpectedly',
    );

    expect(assetRepository.update).not.toHaveBeenCalled();
  });

  describe('a render that fails', () => {
    it('marks the job and asset failed and throws for a retry while it holds the job', async () => {
      const { service, claimToken, transactionManager } = createRender({ render: 'fails' });

      await expect(service.processJobById(job.id, job.assetId)).rejects.toThrow(
        'FFmpeg exited with code 1',
      );

      expect(transactionManager.update).toHaveBeenCalledWith(
        MediaRenderJobEntity,
        heldBy(claimToken()),
        expect.objectContaining({ status: 'failed', errorCode: 'PROCESSING_FAILED' }),
      );
      expect(transactionManager.update).toHaveBeenCalledWith(
        AssetEntity,
        'asset-1',
        assetMarkedFailed,
      );
    });

    it('leaves the asset to the new owner and is not retried once it lost the job', async () => {
      const { service, transactionManager } = createRender({
        render: 'fails',
        finalWriteAffected: 0,
      });

      await expect(service.processJobById(job.id, job.assetId)).resolves.toBeUndefined();

      expect(transactionManager.update).not.toHaveBeenCalledWith(
        AssetEntity,
        'asset-1',
        assetMarkedFailed,
      );
    });
  });
});
