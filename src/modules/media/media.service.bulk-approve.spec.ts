import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectMediaEvaluationEntity } from '../../database/entities/project-media-evaluation.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { AuditService } from '../audit/audit.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { MediaService } from './media.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

type Media = { id: string; projectId: string; evaluationStatus: string };

describe('MediaService bulk approval', () => {
  function createService(options: {
    media: Media[];
    projects?: Array<{ id: string; folderId: string }>;
    canAccess?: boolean;
  }) {
    const projects = options.projects ?? [{ id: 'project', folderId: 'folder' }];
    const lockQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(options.media),
    };
    const countQuery = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest
        .fn()
        .mockResolvedValue({ total: '0', pending: '0', approved: '0', rejected: '0' }),
    };
    const manager = {
      createQueryBuilder: jest.fn().mockReturnValueOnce(lockQuery).mockReturnValue(countQuery),
      find: jest.fn(async (entity: unknown) =>
        entity === ProjectEvaluationSummaryEntity ? [] : projects,
      ),
      update: jest.fn().mockResolvedValue(undefined),
      insert: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) =>
      callback(manager),
    );
    const canAccess = jest.fn().mockResolvedValue(options.canAccess ?? true);
    const recordMany = jest.fn().mockResolvedValue(undefined);
    const service = new MediaService(
      { transaction } as unknown as DataSource,
      {} as never,
      {} as never,
      {} as never,
      { canAccess } as unknown as FolderAccessService,
      {} as never,
      { recordMany } as unknown as AuditService,
      {} as never,
      {} as never,
    );
    return { service, manager, lockQuery, canAccess, recordMany };
  }

  it('approves only the selected files that are not approved yet', async () => {
    const { service, manager, lockQuery, canAccess, recordMany } = createService({
      media: [
        { id: 'a', projectId: 'project', evaluationStatus: 'pending' },
        { id: 'b', projectId: 'project', evaluationStatus: 'rejected' },
        { id: 'c', projectId: 'project', evaluationStatus: 'approved' },
      ],
    });

    const result = await service.bulkApproveMedia(
      { mediaIds: ['a', 'b', 'c'], comment: '  ok  ' },
      'alice',
      'USER',
    );

    expect(lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    expect(canAccess).toHaveBeenCalledWith('folder', 'alice', 'editor', 'USER', manager);
    const mediaUpdates = manager.update.mock.calls.filter(
      ([entity]: unknown[]) => entity === ProjectMediaEntity,
    );
    expect(mediaUpdates).toHaveLength(1);
    expect(mediaUpdates[0][2]).toEqual({ evaluationStatus: 'approved' });
    // The project status is re-derived from its files afterwards.
    expect(manager.update).toHaveBeenCalledWith(ProjectEntity, 'project', expect.anything());
    expect(manager.insert).toHaveBeenCalledWith(ProjectMediaEvaluationEntity, [
      expect.objectContaining({ projectMediaId: 'a', evaluationStatus: 'approved', comment: 'ok' }),
      expect.objectContaining({ projectMediaId: 'b', evaluationStatus: 'approved', comment: 'ok' }),
    ]);
    expect(result).toMatchObject({ approvedCount: 2, unchangedCount: 1 });
    expect(recordMany).toHaveBeenCalledWith([
      expect.objectContaining({
        projectMediaId: 'a',
        action: 'evaluation_changed',
        afterData: expect.objectContaining({ previousEvaluationStatus: 'pending' }),
      }),
      expect.objectContaining({
        projectMediaId: 'b',
        afterData: expect.objectContaining({ previousEvaluationStatus: 'rejected' }),
      }),
    ]);
  });

  it('rejects unknown file ids without writing', async () => {
    const { service, manager, recordMany } = createService({
      media: [{ id: 'a', projectId: 'project', evaluationStatus: 'pending' }],
    });

    await expect(
      service.bulkApproveMedia({ mediaIds: ['a', 'missing'] }, 'alice', 'USER'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(manager.update).not.toHaveBeenCalled();
    expect(recordMany).not.toHaveBeenCalled();
  });

  it('rejects without writing when a project is not editable', async () => {
    const { service, manager, recordMany } = createService({
      media: [{ id: 'a', projectId: 'project', evaluationStatus: 'pending' }],
      canAccess: false,
    });

    await expect(
      service.bulkApproveMedia({ mediaIds: ['a'] }, 'alice', 'USER'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.update).not.toHaveBeenCalled();
    expect(recordMany).not.toHaveBeenCalled();
  });

  it('only targets pending files of the projects unless rejected ones are overridden', async () => {
    const pendingOnly = createService({ media: [] });
    await pendingOnly.service.bulkApproveProjects({ projectIds: ['project'] }, 'alice', 'USER');
    expect(pendingOnly.lockQuery.andWhere).toHaveBeenCalledWith(
      'media.evaluation_status IN (:...statuses)',
      { statuses: ['pending'] },
    );
    expect(pendingOnly.manager.update).not.toHaveBeenCalledWith(
      ProjectMediaEntity,
      expect.anything(),
      expect.anything(),
    );

    const override = createService({ media: [] });
    await override.service.bulkApproveProjects(
      { projectIds: ['project'], overrideRejected: true },
      'alice',
      'USER',
    );
    expect(override.lockQuery.andWhere).toHaveBeenCalledWith(
      'media.evaluation_status IN (:...statuses)',
      { statuses: ['pending', 'rejected'] },
    );
  });

  it('checks each folder once when several projects share it', async () => {
    const { service, canAccess } = createService({
      media: [],
      projects: [
        { id: 'p1', folderId: 'folder' },
        { id: 'p2', folderId: 'folder' },
      ],
    });

    await service.bulkApproveProjects({ projectIds: ['p1', 'p2'] }, 'alice', 'USER');

    expect(canAccess).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown project ids', async () => {
    const { service } = createService({ media: [] });

    await expect(
      service.bulkApproveProjects({ projectIds: ['project', 'missing'] }, 'alice', 'USER'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
