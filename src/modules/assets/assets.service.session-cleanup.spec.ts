import type { ConfigService } from '@nestjs/config';
import { In, type DataSource } from 'typeorm';
import type { OutboxService } from '../../common/outbox.service';
import type { FolderAccessService } from '../folders/folder-access.service';
import { AssetsService } from './assets.service';
import type { StorageAdapter } from './storage/storage-adapter';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

describe('AssetsService expired upload session cleanup', () => {
  function createService(sessions: Array<{ id: string; stillOpen: boolean }>) {
    const expiresAt = new Date(Date.now() - 60_000);
    const sessionRepository = {
      find: jest.fn().mockResolvedValue(
        sessions.map(({ id }) => ({
          id,
          assetId: `asset-of-${id}`,
          storageKey: `projects/p1/originals/${id}.mp4`,
          multipartUploadId: null,
          expiresAt,
        })),
      ),
      // Only a session still open matches the conditional expire.
      update: jest.fn(async ({ id }: { id: string }) => ({
        affected: sessions.find((session) => session.id === id)?.stillOpen ? 1 : 0,
      })),
    };
    const assetRepository = { update: jest.fn() };
    const storage = { deleteObject: jest.fn(), abortMultipartUpload: jest.fn() };
    const service = new AssetsService(
      {} as DataSource,
      assetRepository as never,
      sessionRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as FolderAccessService,
      {} as ConfigService,
      storage as unknown as StorageAdapter,
      {} as OutboxService,
    );
    return { service, sessionRepository, assetRepository, storage };
  }

  it('discards an abandoned upload but keeps one completed since it was read', async () => {
    const { service, sessionRepository, assetRepository, storage } = createService([
      { id: 'abandoned', stillOpen: true },
      // The API completed this upload between the read and the expire.
      { id: 'completed-meanwhile', stillOpen: false },
    ]);

    await expect(service.cleanupExpiredSessions()).resolves.toBe(1);

    expect(sessionRepository.update).toHaveBeenCalledWith(
      { id: 'completed-meanwhile', status: In(['initiated', 'uploading']) },
      { status: 'expired' },
    );
    expect(assetRepository.update).toHaveBeenCalledTimes(1);
    expect(assetRepository.update).toHaveBeenCalledWith('asset-of-abandoned', {
      processingStatus: 'cancelled',
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith('projects/p1/originals/abandoned.mp4');
  });
});
