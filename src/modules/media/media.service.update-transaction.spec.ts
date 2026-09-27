import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { MediaService } from './media.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

describe('MediaService.update', () => {
  function createService(canAccessResult: boolean) {
    const media = {
      id: 'media',
      projectId: 'project',
      sortOrder: 0,
      caption: null,
      evaluationStatus: 'pending',
    };
    const mediaQuery = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(media),
    };
    const manager = {
      createQueryBuilder: jest.fn().mockReturnValue(mediaQuery),
      findOne: jest.fn().mockResolvedValue({ id: 'project', folderId: 'folder' }),
      save: jest.fn(async (value: unknown) => value),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) =>
      callback(manager),
    );
    const canAccess = jest.fn().mockResolvedValue(canAccessResult);
    // Empty repositories: any query outside the transaction's manager fails the test.
    const service = new MediaService(
      { transaction } as unknown as DataSource,
      {} as never,
      {} as never,
      {} as never,
      { canAccess } as unknown as FolderAccessService,
      {} as never,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      {} as never,
      {} as never,
    );
    return { service, manager, mediaQuery, canAccess };
  }

  it('checks project access on the transaction manager that holds the media lock', async () => {
    const { service, manager, mediaQuery, canAccess } = createService(true);

    await service.update('media', { caption: 'New caption' }, 'alice', ['go.project.edit'], 'USER');

    expect(mediaQuery.setLock).toHaveBeenCalledWith('pessimistic_write', undefined, ['media']);
    expect(canAccess).toHaveBeenCalledWith('folder', 'alice', 'editor', 'USER', manager);
    expect(manager.save).toHaveBeenCalled();
  });

  it('rejects without saving when the project is not editable', async () => {
    const { service, manager, canAccess } = createService(false);

    await expect(
      service.update('media', { caption: 'New caption' }, 'alice', ['go.project.edit'], 'USER'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(canAccess).toHaveBeenCalledWith('folder', 'alice', 'editor', 'USER', manager);
    expect(manager.save).not.toHaveBeenCalled();
  });
});
