jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));

// uuid ships as ESM; mock it so Jest (CommonJS mode) can load it.
jest.mock('uuid', () => ({ v7: () => 'mock-uuid-v7', v4: () => 'mock-uuid-v4' }));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DownloadsService } from './downloads.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    assetId: 'asset-1',
    projectId: 'proj-1',
    sortOrder: 0,
    ...overrides,
  };
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    folderId: 'folder-1',
    ...overrides,
  };
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dl-job-1',
    externalUserId: 'user-1',
    status: 'queued',
    totalItems: 1,
    completedItems: 0,
    zipStorageKey: null,
    zipBucket: null,
    zipSizeBytes: null,
    expiresAt: null,
    errorMessage: null,
    queueJobId: null,
    idempotencyKey: null,
    scope: 'project',
    downloadType: 'rendered',
    createdAt: new Date('2024-06-01'),
    ...overrides,
  };
}

function createService(
  overrides: {
    media?: ReturnType<typeof makeMedia>[];
    project?: ReturnType<typeof makeProject> | null;
    job?: ReturnType<typeof makeJob> | null;
    canViewProject?: boolean;
    isAdmin?: boolean;
  } = {},
) {
  const {
    media = [makeMedia()],
    project = makeProject(),
    job = makeJob(),
    canViewProject = true,
    isAdmin = false,
  } = overrides;

  // Repositories
  const jobRepo = {
    findOne: jest.fn().mockResolvedValue(job),
    findOneOrFail: jest.fn().mockResolvedValue(job),
    update: jest.fn().mockResolvedValue({}),
  };
  const itemRepo = {};
  const logRepo = {
    save: jest.fn().mockResolvedValue({ id: 'log-1' }),
    create: jest.fn().mockImplementation((_: unknown, v: unknown) => v ?? _),
  };
  const mediaRepo = {
    findBy: jest.fn().mockResolvedValue(media),
    find: jest.fn().mockResolvedValue(media),
  };
  const projectRepo = {
    findBy: jest.fn().mockResolvedValue(project ? [project] : []),
    findOne: jest.fn().mockResolvedValue(project),
  };
  const assetRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: 'asset-1',
      originalStorageKey: 'key/file.mp4',
      mimeType: 'video/mp4',
      fileSizeBytes: 1024,
      originalFilename: 'clip.mp4',
    }),
  };
  const variantRepo = {
    findOne: jest.fn().mockResolvedValue(null),
  };
  const profileRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 'profile-1', profileVersion: 1 }),
  };

  const dataSource = {
    transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => {
      const manager = {
        save: jest.fn().mockResolvedValue(job),
        create: jest.fn().mockImplementation((_: unknown, v: unknown) => v ?? _),
        insert: jest.fn().mockResolvedValue({}),
        query: jest.fn().mockResolvedValue([]),
      };
      return cb(manager);
    }),
    query: jest.fn().mockResolvedValue([]),
  };

  const folderAccess = {
    canViewProject: jest.fn().mockResolvedValue(canViewProject),
  };
  const config = {
    getOrThrow: jest.fn().mockReturnValue(3600),
  };
  const storage = {
    getPresignedGetUrl: jest.fn().mockResolvedValue('https://example.com/signed'),
  };
  const downloadQueue = {
    addJob: jest.fn().mockResolvedValue(undefined),
  };
  const actorEnrichment = {
    enrich: jest.fn().mockImplementation((items: unknown[]) => Promise.resolve(items)),
  };

  const service = new DownloadsService(
    dataSource as never,
    jobRepo as never,
    itemRepo as never,
    logRepo as never,
    mediaRepo as never,
    projectRepo as never,
    assetRepo as never,
    variantRepo as never,
    profileRepo as never,
    folderAccess as never,
    config as never,
    storage as never,
    downloadQueue as never,
    actorEnrichment as never,
  );

  const userType = isAdmin ? 'ADMIN' : ('USER' as const);
  return {
    service,
    jobRepo,
    mediaRepo,
    folderAccess,
    downloadQueue,
    dataSource,
    storage,
    userType,
    logRepo,
  };
}

// ---------------------------------------------------------------------------
// create() — permission checks
// ---------------------------------------------------------------------------

describe('DownloadsService.create — permission checks', () => {
  it('throws ForbiddenException when user lacks download_rendered permission', async () => {
    const { service } = createService({ isAdmin: false });
    await expect(
      service.create(
        { scope: 'project', projectId: 'proj-1', downloadType: 'rendered' },
        'user-1',
        [], // no permissions
        'USER',
        undefined,
        {},
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when user lacks download_original permission', async () => {
    const { service } = createService({ isAdmin: false });
    await expect(
      service.create(
        { scope: 'project', projectId: 'proj-1', downloadType: 'original' },
        'user-1',
        ['go.project.download_rendered'], // missing download_original
        'USER',
        undefined,
        {},
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws NotFoundException when no project media is found', async () => {
    const { service } = createService({ media: [] });
    await expect(
      service.create(
        { scope: 'project', projectId: 'proj-1', downloadType: 'rendered' },
        'user-1',
        ['go.project.download_rendered'],
        'USER',
        undefined,
        {},
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when user cannot view the project', async () => {
    const { service } = createService({ canViewProject: false });
    await expect(
      service.create(
        { scope: 'project', projectId: 'proj-1', downloadType: 'rendered' },
        'user-1',
        ['go.project.download_rendered'],
        'USER',
        undefined,
        {},
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows ADMIN to bypass the explicit permission check', async () => {
    const { service, downloadQueue } = createService({ isAdmin: true, canViewProject: true });
    await service.create(
      { scope: 'project', projectId: 'proj-1', downloadType: 'rendered' },
      'admin-1',
      [], // no explicit permissions — ADMIN is exempt
      'ADMIN',
      undefined,
      {},
    );
    expect(downloadQueue.addJob).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// create() — single scope
// ---------------------------------------------------------------------------

describe('DownloadsService.create — single scope', () => {
  it('returns a signed URL immediately for single scope (no job created)', async () => {
    const { service, downloadQueue } = createService();
    const result = await service.create(
      { scope: 'single', projectMediaIds: ['media-1'], downloadType: 'original' },
      'user-1',
      ['go.project.download_original'],
      'USER',
      undefined,
      {},
    );
    expect(result).toMatchObject({ mode: 'single', url: expect.any(String) });
    expect(downloadQueue.addJob).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when single scope has multiple media items', async () => {
    const { service } = createService({
      media: [makeMedia({ id: 'm1' }), makeMedia({ id: 'm2' })],
    });
    const { BadRequestException } = await import('@nestjs/common');
    await expect(
      service.create(
        { scope: 'single', projectMediaIds: ['m1', 'm2'], downloadType: 'original' },
        'user-1',
        ['go.project.download_original'],
        'USER',
        undefined,
        {},
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// create() — idempotency
// ---------------------------------------------------------------------------

describe('DownloadsService.create — idempotency key', () => {
  it('returns the existing job when idempotency key matches', async () => {
    const existingJob = makeJob({ id: 'existing-job', status: 'completed' });
    const { service, dataSource, jobRepo } = createService();
    // Simulate finding an existing job by idempotency key
    dataSource.query.mockResolvedValueOnce([{ id: 'existing-job' }]);
    jobRepo.findOne.mockResolvedValue(existingJob);
    const result = await service.create(
      { scope: 'project', projectId: 'proj-1', downloadType: 'rendered' },
      'user-1',
      ['go.project.download_rendered'],
      'USER',
      'idempotency-key-abc',
      {},
    );
    expect(result).toMatchObject({ id: 'existing-job', status: 'completed' });
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe('DownloadsService.get', () => {
  it('throws NotFoundException when job is not found', async () => {
    const { service } = createService({ job: null });
    await expect(service.get('dl-job-1', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('marks the job as expired when expiresAt is in the past', async () => {
    const expiredJob = makeJob({
      status: 'completed',
      expiresAt: new Date(Date.now() - 10_000),
      zipStorageKey: null,
    });
    const { service, jobRepo } = createService({ job: expiredJob });
    jobRepo.findOne.mockResolvedValue(expiredJob);
    const result = await service.get('dl-job-1', 'user-1');
    expect(jobRepo.update).toHaveBeenCalledWith('dl-job-1', { status: 'expired' });
    expect((result as Record<string, unknown>).status).toBe('expired');
  });

  it('generates a presigned URL for a completed job with a storage key', async () => {
    const completedJob = makeJob({ status: 'completed', zipStorageKey: 'zip/file.zip' });
    const { service, storage } = createService({ job: completedJob });
    const result = await service.get('dl-job-1', 'user-1');
    expect(storage.getPresignedGetUrl).toHaveBeenCalled();
    expect((result as Record<string, unknown>).url).toBe('https://example.com/signed');
  });
});

// ---------------------------------------------------------------------------
// cancel()
// ---------------------------------------------------------------------------

describe('DownloadsService.cancel', () => {
  it('throws NotFoundException when job is not found', async () => {
    const { service } = createService({ job: null });
    await expect(service.cancel('dl-job-1', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it.each(['completed', 'failed', 'expired', 'cancelled'])(
    'returns job as-is when already in terminal state "%s"',
    async (status) => {
      const { service } = createService({ job: makeJob({ status }) });
      const result = await service.cancel('dl-job-1', 'user-1');
      expect((result as unknown as Record<string, unknown>).status).toBe(status);
    },
  );

  it('sets status to cancelled for an active job', async () => {
    const { service, jobRepo } = createService({ job: makeJob({ status: 'queued' }) });
    jobRepo.findOneOrFail.mockResolvedValue(makeJob({ status: 'cancelled' }));
    const result = await service.cancel('dl-job-1', 'user-1');
    expect(jobRepo.update).toHaveBeenCalledWith('dl-job-1', { status: 'cancelled' });
    expect((result as unknown as Record<string, unknown>).status).toBe('cancelled');
  });
});
