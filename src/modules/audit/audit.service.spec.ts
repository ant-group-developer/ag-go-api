import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditService } from './audit.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

function mockRepo(total = 0) {
  const rows: unknown[] = [];
  return {
    findAndCount: jest.fn().mockResolvedValue([rows, total]),
    manager: { query: jest.fn().mockResolvedValue([]) },
    save: jest.fn(),
    create: jest.fn(),
  };
}

function createService(
  overrides: { projectExists?: boolean; canView?: boolean; total?: number } = {},
) {
  const { projectExists = true, canView = true, total = 0 } = overrides;
  const auditRepo = mockRepo(total);
  const projectRepo = {
    findOne: jest.fn().mockResolvedValue(projectExists ? { id: 'pid', folderId: 'fid' } : null),
  };
  const folderAccess = {
    canViewProject: jest.fn().mockResolvedValue(canView),
  };
  const actorEnrichment = {
    enrich: jest.fn().mockImplementation((items: unknown[]) => Promise.resolve(items)),
  };

  const service = new AuditService(
    auditRepo as never,
    projectRepo as never,
    folderAccess as never,
    actorEnrichment as never,
  );

  return { service, auditRepo };
}

describe('AuditService.listProject pagination', () => {
  it('clamps page and pageSize before computing skip and take', async () => {
    const { service, auditRepo } = createService({ total: 300 });

    const result = await service.listProject('pid', 'uid', 'USER', 3, 200);

    // pageSize should be clamped to 100
    const findCall = auditRepo.findAndCount.mock.calls[0][0];
    expect(findCall.take).toBe(100);
    // skip = (3-1) * 100 = 200  (consistent with clamped pageSize)
    expect(findCall.skip).toBe(200);
    // Response reflects clamped values
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(100);
    expect(result.totalPages).toBe(3); // ceil(300/100)
  });

  it('defaults NaN page/pageSize to 1', async () => {
    const { service, auditRepo } = createService({ total: 50 });

    const result = await service.listProject('pid', 'uid', 'USER', NaN, NaN);

    const findCall = auditRepo.findAndCount.mock.calls[0][0];
    expect(findCall.skip).toBe(0); // (1-1)*1
    expect(findCall.take).toBe(1); // Math.trunc(NaN)||1 → 1
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(1);
  });

  it('clamps negative page to 1', async () => {
    const { service, auditRepo } = createService({ total: 10 });

    const result = await service.listProject('pid', 'uid', 'USER', -5, 10);

    const findCall = auditRepo.findAndCount.mock.calls[0][0];
    expect(findCall.skip).toBe(0);
    expect(result.page).toBe(1);
  });

  it('clamps pageSize of 0 to 1', async () => {
    const { service, auditRepo } = createService({ total: 5 });

    const result = await service.listProject('pid', 'uid', 'USER', 1, 0);

    const findCall = auditRepo.findAndCount.mock.calls[0][0];
    expect(findCall.take).toBe(1);
    expect(result.pageSize).toBe(1);
  });

  it('throws NotFoundException when project does not exist', async () => {
    const { service } = createService({ projectExists: false });
    await expect(service.listProject('pid', 'uid')).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when user cannot view project', async () => {
    const { service } = createService({ canView: false });
    await expect(service.listProject('pid', 'uid')).rejects.toThrow(ForbiddenException);
  });
});
