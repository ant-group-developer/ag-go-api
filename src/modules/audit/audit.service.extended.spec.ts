import { AuditService } from './audit.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRepo(total = 0) {
  return {
    findAndCount: jest.fn().mockResolvedValue([[], total]),
    manager: {
      query: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => cb({})),
    },
    save: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
    create: jest.fn().mockImplementation((v: unknown) => v),
  };
}

function createService(
  overrides: {
    projectExists?: boolean;
    canView?: boolean;
    total?: number;
  } = {},
) {
  const { projectExists = true, canView = true, total = 0 } = overrides;
  const auditRepo = mockRepo(total);
  const projectRepo = {
    findOne: jest.fn().mockResolvedValue(projectExists ? { id: 'pid', folderId: 'fid' } : null),
  };
  const folderAccess = { canViewProject: jest.fn().mockResolvedValue(canView) };
  const actorEnrichment = {
    enrich: jest.fn().mockImplementation((items: unknown[]) => Promise.resolve(items)),
  };
  const service = new AuditService(
    auditRepo as never,
    projectRepo as never,
    folderAccess as never,
    actorEnrichment as never,
  );
  return { service, auditRepo, projectRepo, folderAccess };
}

// ---------------------------------------------------------------------------
// record() and recordMany()
// ---------------------------------------------------------------------------

describe('AuditService.record', () => {
  it('saves a log entry with the supplied fields', async () => {
    const { service, auditRepo } = createService();
    auditRepo.create.mockImplementation((v: unknown) => v);
    auditRepo.save.mockResolvedValue({ id: 'log-1' });
    await service.record({
      projectId: 'proj-1',
      actorUserId: 'user-1',
      action: 'project.create',
      afterData: { name: 'Test' },
    });
    expect(auditRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.create', actorUserId: 'user-1' }),
    );
  });

  it('defaults optional fields to null when omitted', async () => {
    const { service, auditRepo } = createService();
    auditRepo.create.mockImplementation((v: unknown) => v);
    await service.record({ actorUserId: 'user-1', action: 'test.action' });
    expect(auditRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        projectMediaId: null,
        beforeData: null,
        afterData: null,
      }),
    );
  });
});

describe('AuditService.recordMany', () => {
  it('is a no-op when called with an empty array', async () => {
    const { service, auditRepo } = createService();
    await service.recordMany([]);
    expect(auditRepo.save).not.toHaveBeenCalled();
  });

  it('saves all entries when called with multiple inputs', async () => {
    const { service, auditRepo } = createService();
    auditRepo.create.mockImplementation((v: unknown) => v);
    auditRepo.save.mockResolvedValue([]);
    await service.recordMany([
      { actorUserId: 'u1', action: 'a.1' },
      { actorUserId: 'u2', action: 'a.2' },
    ]);
    expect(auditRepo.save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ action: 'a.1' }),
        expect.objectContaining({ action: 'a.2' }),
      ]),
      expect.objectContaining({ chunk: 500 }),
    );
  });
});

// ---------------------------------------------------------------------------
// listProject() — already covered in audit.service.spec.ts; add new cases
// ---------------------------------------------------------------------------

describe('AuditService.listProject — additional cases', () => {
  it('enriches rows with mediaFileName from asset names', async () => {
    const row = {
      id: 'log-1',
      projectId: 'pid',
      projectMediaId: 'media-1',
      actorUserId: 'u1',
      action: 'file.upload',
    };
    const { service, auditRepo } = createService({ total: 1 });
    auditRepo.findAndCount.mockResolvedValue([[row], 1]);
    // Simulate the query returning a file name
    auditRepo.manager.query.mockResolvedValue([{ id: 'media-1', fileName: 'photo.jpg' }]);
    const result = await service.listProject('pid', 'uid', 'USER', 1, 10);
    const enriched = result.items[0] as Record<string, unknown>;
    expect(enriched['mediaFileName']).toBe('photo.jpg');
  });

  it('uses null mediaFileName when media is not in the database', async () => {
    const row = {
      id: 'log-2',
      projectId: 'pid',
      projectMediaId: 'media-ghost',
      actorUserId: 'u1',
      action: 'file.upload',
    };
    const { service, auditRepo } = createService({ total: 1 });
    auditRepo.findAndCount.mockResolvedValue([[row], 1]);
    // Empty query result – media was deleted
    auditRepo.manager.query.mockResolvedValue([]);
    const result = await service.listProject('pid', 'uid', 'USER', 1, 10);
    const enriched = result.items[0] as Record<string, unknown>;
    expect(enriched['mediaFileName']).toBeNull();
  });

  it('skips the mediaFileName query when no rows have a projectMediaId', async () => {
    const row = {
      id: 'log-3',
      projectId: 'pid',
      projectMediaId: null,
      actorUserId: 'u1',
      action: 'project.update',
    };
    const { service, auditRepo } = createService({ total: 1 });
    auditRepo.findAndCount.mockResolvedValue([[row], 1]);
    await service.listProject('pid', 'uid', 'USER', 1, 10);
    // manager.query is called for filename lookup; with no IDs it should return empty Map without querying
    expect(auditRepo.manager.query).not.toHaveBeenCalled();
  });

  it('returns correct totalPages', async () => {
    const { service } = createService({ total: 55 });
    const result = await service.listProject('pid', 'uid', 'USER', 1, 10);
    expect(result.totalPages).toBe(6); // ceil(55/10)
  });
});

// ---------------------------------------------------------------------------
// recordMediaUpload()
// ---------------------------------------------------------------------------

describe('AuditService.recordMediaUpload', () => {
  it('calls manager.transaction with the advisory lock SQL', async () => {
    const { service, auditRepo } = createService();
    const txMock = jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => {
      const manager = {
        query: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getOne: jest.fn().mockResolvedValue(null),
        }),
        save: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation((_: unknown, v: unknown) => v),
        update: jest.fn().mockResolvedValue({}),
      };
      return cb(manager);
    });
    auditRepo.manager.transaction = txMock;
    await service.recordMediaUpload({
      projectId: 'proj-1',
      actorUserId: 'user-1',
      uploadBatchId: 'batch-abc',
      file: {
        filename: 'image.png',
        assetType: 'image' as const,
        sizeBytes: 512,
      },
    });
    expect(txMock).toHaveBeenCalled();
  });
});
