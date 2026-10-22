// Jest hoists jest.mock() calls, so these run before any imports.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));

// uuid ships as ESM; mock it so Jest (CommonJS mode) can load it.
jest.mock('uuid', () => ({ v7: () => 'mock-uuid-v7', v4: () => 'mock-uuid-v4' }));

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RenderService } from './render.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    assetId: 'asset-1',
    renderBatchId: null,
    renderVersion: 1,
    status: 'failed',
    dedupeKey: 'asset-1:profile-1:1',
    createdAt: new Date('2024-01-01'),
    renderSummary: null,
    ...overrides,
  };
}

function makeBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch-1',
    projectId: 'proj-1',
    folderId: null,
    renderProfileId: 'profile-1',
    status: 'queued',
    totalJobs: 3,
    completedJobs: 0,
    failedJobs: 0,
    progressPercent: 0,
    createdBy: 'user-1',
    ...overrides,
  };
}

/** Returns a query builder stub with every method used by pageJobs / pageBatches. */
function makeQb(extra: Record<string, unknown> = {}) {
  const terminalMethods = new Set([
    'getRawOne',
    'getMany',
    'getExists',
    'getOne',
    'clone',
    'execute',
    'getCount',
  ]);
  const qb: Record<string, jest.Mock> = {
    where: jest.fn(),
    andWhere: jest.fn(),
    select: jest.fn(),
    addSelect: jest.fn(),
    setParameter: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    offset: jest.fn(),
    limit: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    update: jest.fn(),
    set: jest.fn(),
    setLock: jest.fn(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
    getCount: jest.fn().mockResolvedValue(0),
    getRawOne: jest
      .fn()
      .mockResolvedValue({ all: 0, active: 0, completed: 0, failed: 0, cancelled: 0 }),
    getMany: jest.fn().mockResolvedValue([]),
    getExists: jest.fn().mockResolvedValue(false),
    getOne: jest.fn().mockResolvedValue(null),
    clone: jest.fn(),
    ...extra,
  };
  // Every chainable method returns the same qb object; clone returns a fresh copy
  for (const key of Object.keys(qb)) {
    if (!terminalMethods.has(key)) {
      (qb[key] as jest.Mock).mockReturnValue(qb);
    }
  }
  // clone() gives a new stub when actually called during a test (lazy, not during setup)
  qb['clone'].mockImplementation(() => makeQb());
  return qb;
}

/** A minimal entity manager that satisfies recountRenderBatch's createQueryBuilder(Entity, alias) call. */
function makeNestedManager() {
  return {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
    find: jest.fn().mockResolvedValue([]),
  };
}

/** Builds a minimal RenderService with injected mocks. */
function createService(
  overrides: {
    batch?: Record<string, unknown> | null;
    job?: Record<string, unknown> | null;
    canAccess?: boolean;
    canViewProject?: boolean;
    hasNewerJob?: boolean;
    batchUpdateAffected?: number;
  } = {},
) {
  const {
    batch = makeBatch(),
    job = makeJob(),
    canAccess = true,
    canViewProject = true,
    hasNewerJob = false,
    batchUpdateAffected = 0,
  } = overrides;

  // --- Batch repo ---
  const batchFindOne = jest.fn().mockResolvedValue(batch);
  const batchFindOneOrFail = jest.fn().mockResolvedValue(batch);
  const batchUpdate = jest.fn().mockResolvedValue({ affected: batchUpdateAffected });
  const batchRepo = {
    findOne: batchFindOne,
    findOneOrFail: batchFindOneOrFail,
    update: batchUpdate,
    createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
  };

  // --- Job repo ---
  const jobFindOne = jest.fn().mockResolvedValue(job);
  const jobFindOneOrFail = jest.fn().mockResolvedValue(job);
  const jobRepo = {
    findOne: jobFindOne,
    findOneOrFail: jobFindOneOrFail,
    find: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
    createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
  };

  const profileRepo = { findOne: jest.fn().mockResolvedValue(null) };
  const projectRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'proj-1', folderId: 'folder-1' }),
    findBy: jest.fn().mockResolvedValue([{ id: 'proj-1', folderId: 'folder-1' }]),
    createQueryBuilder: jest.fn().mockReturnValue(
      makeQb({
        getMany: jest.fn().mockResolvedValue([{ id: 'proj-1', folderId: 'folder-1' }]),
      }),
    ),
  };
  const mediaRepo = { findBy: jest.fn().mockResolvedValue([]) };
  const assetRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    findBy: jest.fn().mockResolvedValue([]),
  };

  const transactionFn = jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => {
    const manager = {
      findOne: jest.fn().mockResolvedValue(batch),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      insert: jest.fn().mockResolvedValue({}),
      save: jest.fn().mockResolvedValue(batch),
      create: jest.fn().mockImplementation((_: unknown, v: unknown) => v),
      query: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(makeQb()),
      // refreshRenderBatch calls manager.transaction(cb) → recountRenderBatch needs a real manager
      transaction: jest
        .fn()
        .mockImplementation(async (cb2: (m: unknown) => unknown) => cb2(makeNestedManager())),
    };
    return cb(manager);
  });

  const dataSource = {
    transaction: transactionFn,
    manager: {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(makeQb({ getExists: jest.fn().mockResolvedValue(hasNewerJob) })),
    },
    // Return a folderId row so assertAssetRenderAccess (retryJob for non-batch jobs) doesn't fail
    query: jest.fn().mockResolvedValue([{ folderId: 'folder-1' }]),
    getRepository: jest.fn().mockReturnValue({
      find: jest.fn().mockResolvedValue([]),
    }),
  };

  const folderAccess = {
    canAccess: jest.fn().mockResolvedValue(canAccess),
    canAccessProject: jest.fn().mockResolvedValue(canAccess),
    canViewProject: jest.fn().mockResolvedValue(canViewProject),
    accessibleFolderIds: jest.fn().mockResolvedValue([]),
  };
  const mediaQueue = { addProcessingJob: jest.fn().mockResolvedValue(undefined) };
  const actorEnrichment = {
    enrich: jest.fn().mockImplementation((items: unknown[]) => Promise.resolve(items)),
  };
  const config = {
    getOrThrow: jest.fn().mockReturnValue(3),
  };

  const service = new RenderService(
    dataSource as never,
    profileRepo as never,
    batchRepo as never,
    jobRepo as never,
    projectRepo as never,
    mediaRepo as never,
    assetRepo as never,
    folderAccess as never,
    mediaQueue as never,
    actorEnrichment as never,
    config as never,
  );

  return {
    service,
    batchRepo,
    batchFindOne,
    batchFindOneOrFail,
    batchUpdate,
    jobFindOne,
    jobRepo,
    folderAccess,
    mediaQueue,
    dataSource,
    config,
  };
}

// ---------------------------------------------------------------------------
// pageBounds (exercised via listAutoJobs for ADMIN — goes all the way to pageJobs)
// ---------------------------------------------------------------------------

describe('pageBounds clamping', () => {
  it('clamps page below 1 to 1', async () => {
    const { service } = createService();
    const result = await service.listAutoJobs('user-1', 'ADMIN', { page: 0, pageSize: 10 });
    expect(result.page).toBe(1);
  });

  it('truncates fractional page via Math.trunc', async () => {
    const { service } = createService();
    const result = await service.listAutoJobs('user-1', 'ADMIN', { page: 2.9, pageSize: 10 });
    expect(result.page).toBe(2);
  });

  it('clamps pageSize above 100 to 100', async () => {
    const { service } = createService();
    const result = await service.listAutoJobs('user-1', 'ADMIN', { page: 1, pageSize: 9999 });
    expect(result.pageSize).toBe(100);
  });

  it('clamps NaN page and pageSize to 1', async () => {
    const { service } = createService();
    const result = await service.listAutoJobs('user-1', 'ADMIN', { page: NaN, pageSize: NaN });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(1);
  });

  it('defaults page to 1 and pageSize to 20 when not provided', async () => {
    const { service } = createService();
    const result = await service.listAutoJobs('user-1', 'ADMIN', {});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
  });

  it('returns an empty page immediately for non-ADMIN with no accessible folders', async () => {
    const { service } = createService();
    const result = await service.listAutoJobs('user-1', 'USER', { page: -3, pageSize: 5 });
    expect(result.items).toEqual([]);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// cancelBatch — state machine
// ---------------------------------------------------------------------------

describe('RenderService.cancelBatch', () => {
  it.each(['completed', 'partial', 'failed', 'cancelled'])(
    'returns as-is when batch is already in terminal state "%s"',
    async (status) => {
      const { service } = createService({ batch: makeBatch({ status }) });
      const result = await service.cancelBatch('batch-1', 'user-1', 'ADMIN');
      expect(result.status).toBe(status);
    },
  );

  it('sets status to cancelled and returns the updated batch', async () => {
    const { service, batchFindOneOrFail } = createService({
      batch: makeBatch({ status: 'queued' }),
    });
    batchFindOneOrFail.mockResolvedValue(makeBatch({ status: 'cancelled' }));
    const result = await service.cancelBatch('batch-1', 'user-1', 'ADMIN');
    expect(result.status).toBe('cancelled');
  });

  it('throws NotFoundException when batch does not exist', async () => {
    const { service } = createService({ batch: null });
    await expect(service.cancelBatch('batch-1', 'user-1', 'ADMIN')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws ForbiddenException when user lacks manager access on the project folder', async () => {
    const { service } = createService({ canAccess: false });
    await expect(service.cancelBatch('batch-1', 'user-1', 'USER')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// pauseBatch — state machine
// ---------------------------------------------------------------------------

describe('RenderService.pauseBatch', () => {
  it('calls batchRepository.update with status paused', async () => {
    const { service, batchUpdate, batchFindOneOrFail } = createService({
      batch: makeBatch({ status: 'queued' }),
    });
    batchFindOneOrFail.mockResolvedValue(makeBatch({ status: 'paused' }));
    await service.pauseBatch('batch-1', 'user-1', 'ADMIN');
    expect(batchUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'batch-1' }), {
      status: 'paused',
    });
  });

  it('returns the batch with paused status', async () => {
    const { service, batchFindOneOrFail } = createService({
      batch: makeBatch({ status: 'processing' }),
    });
    batchFindOneOrFail.mockResolvedValue(makeBatch({ status: 'paused' }));
    const result = await service.pauseBatch('batch-1', 'user-1', 'ADMIN');
    expect(result.status).toBe('paused');
  });

  it('throws ForbiddenException when user lacks access', async () => {
    const { service } = createService({ canAccess: false });
    await expect(service.pauseBatch('batch-1', 'user-1', 'USER')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// resumeBatch — state machine
// ---------------------------------------------------------------------------

describe('RenderService.resumeBatch', () => {
  it('returns the batch with processing status after resuming', async () => {
    const { service, batchFindOneOrFail } = createService({
      batch: makeBatch({ status: 'paused' }),
    });
    batchFindOneOrFail.mockResolvedValue(makeBatch({ status: 'processing' }));
    const result = await service.resumeBatch('batch-1', 'user-1', 'ADMIN');
    expect(result.status).toBe('processing');
  });

  it('reads MEDIA_JOB_ATTEMPTS from config', async () => {
    const { service, config } = createService({ batch: makeBatch({ status: 'paused' }) });
    await service.resumeBatch('batch-1', 'user-1', 'ADMIN');
    expect(config.getOrThrow).toHaveBeenCalledWith('MEDIA_JOB_ATTEMPTS');
  });

  it('throws ForbiddenException when user lacks access', async () => {
    const { service } = createService({ canAccess: false });
    await expect(service.resumeBatch('batch-1', 'user-1', 'USER')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

// ---------------------------------------------------------------------------
// retryJob — per-job retry
// ---------------------------------------------------------------------------

describe('RenderService.retryJob', () => {
  it('throws NotFoundException when the job does not exist', async () => {
    const { service } = createService({ job: null });
    await expect(service.retryJob('job-1', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when the job status is not "failed" (non-batch job with access)', async () => {
    // Non-batch job: assertAssetRenderAccess checks folder access — canAccess=true means it passes
    const { service } = createService({ job: makeJob({ status: 'queued' }), canAccess: true });
    await expect(service.retryJob('job-1', 'user-1', 'ADMIN')).rejects.toThrow(ConflictException);
  });

  it('throws ConflictException when a newer render job exists for the same asset', async () => {
    const { service } = createService({ hasNewerJob: true, canAccess: true });
    await expect(service.retryJob('job-1', 'user-1', 'ADMIN')).rejects.toThrow(ConflictException);
  });

  it('sets job status to queued and enqueues a BullMQ job on success (ADMIN)', async () => {
    const { service, jobRepo, mediaQueue } = createService({ hasNewerJob: false, canAccess: true });
    jobRepo.findOneOrFail.mockResolvedValue(makeJob({ status: 'queued' }));
    const result = await service.retryJob('job-1', 'user-1', 'ADMIN');
    expect(jobRepo.update).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'queued' }),
    );
    expect(mediaQueue.addProcessingJob).toHaveBeenCalledWith(
      expect.objectContaining({ renderJobId: 'job-1' }),
    );
    expect(result.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// retryFailedJobs — batch-level retry guards
// ---------------------------------------------------------------------------

describe('RenderService.retryFailedJobs', () => {
  it('throws ConflictException when the batch is cancelled', async () => {
    const cancelledBatch = makeBatch({ status: 'cancelled' });
    const { service, dataSource } = createService({ batch: cancelledBatch });
    (dataSource.transaction as jest.Mock).mockImplementationOnce(
      async (cb: (m: unknown) => unknown) =>
        cb({ findOne: jest.fn().mockResolvedValue(cancelledBatch) }),
    );
    await expect(service.retryFailedJobs('batch-1', 'user-1', 'ADMIN')).rejects.toThrow(
      ConflictException,
    );
  });

  it('throws ConflictException when the batch is paused', async () => {
    const pausedBatch = makeBatch({ status: 'paused' });
    const { service, dataSource } = createService({ batch: pausedBatch });
    (dataSource.transaction as jest.Mock).mockImplementationOnce(
      async (cb: (m: unknown) => unknown) =>
        cb({ findOne: jest.fn().mockResolvedValue(pausedBatch) }),
    );
    await expect(service.retryFailedJobs('batch-1', 'user-1', 'ADMIN')).rejects.toThrow(
      ConflictException,
    );
  });
});

// ---------------------------------------------------------------------------
// Batch access guard
// ---------------------------------------------------------------------------

describe('RenderService batch access guard', () => {
  it('throws ForbiddenException for a folder-scoped batch when access is denied', async () => {
    const folderBatch = makeBatch({ projectId: null, folderId: 'folder-1' });
    const { service } = createService({ batch: folderBatch, canAccess: false });
    await expect(service.getBatch('batch-1', 'user-1', 'USER')).rejects.toThrow(ForbiddenException);
  });

  it('resolves without error when access is granted', async () => {
    const { service } = createService({ canAccess: true });
    await expect(service.getBatch('batch-1', 'user-1', 'USER')).resolves.toBeDefined();
  });
});
