import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import type { OutboxService } from '../../common/outbox.service';
import type { AssetUploadSessionEntity } from '../../database/entities/asset-upload-session.entity';
import type { FolderAccessService } from '../folders/folder-access.service';
import { AssetsService } from './assets.service';
import type { StorageAdapter } from './storage/storage-adapter';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
let nextId = 0;
jest.mock('uuid', () => ({ v7: () => `id-${(nextId += 1)}` }));

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CONFIG: Record<string, unknown> = {
  MAX_UPLOAD_SIZE_BYTES: 20 * GIB,
  UPLOAD_SESSION_TTL_SECONDS: 3600,
  R2_PRESIGNED_URL_TTL_SECONDS: 900,
  R2_BUCKET: 'bucket',
};

function createService() {
  const storage = {
    getPresignedPutUrl: jest.fn().mockResolvedValue('https://r2.test/put'),
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    getPresignedUploadPartUrl: jest.fn(
      async (_key: string, _uploadId: string, partNumber: number) =>
        `https://r2.test/part-${partNumber}`,
    ),
    listMultipartParts: jest.fn(),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn().mockResolvedValue(null),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const manager = {
    create: (_entity: unknown, values: unknown) => values,
    save: jest.fn(async (values: unknown) => values),
    update: jest.fn(),
  };
  const dataSource = {
    transaction: jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager)),
  };
  const sessionRepository = { findOne: jest.fn(), update: jest.fn() };
  const projectRepository = {
    findOne: jest.fn().mockResolvedValue({ id: 'project-1', folderId: 'folder-1' }),
  };
  const folderAccess = { canAccess: jest.fn().mockResolvedValue(true) };
  const config = {
    getOrThrow: (key: string) => CONFIG[key],
  } as unknown as ConfigService;

  const service = new AssetsService(
    dataSource as unknown as DataSource,
    {} as Repository<never>,
    sessionRepository as unknown as Repository<AssetUploadSessionEntity>,
    {} as Repository<never>,
    {} as Repository<never>,
    projectRepository as unknown as Repository<never>,
    {} as Repository<never>,
    folderAccess as unknown as FolderAccessService,
    config,
    storage as unknown as StorageAdapter,
    {} as OutboxService,
    {} as never,
  );
  return { service, storage, sessionRepository, dataSource };
}

function uploadDto(fileSizeBytes: number) {
  return {
    assetType: 'video' as const,
    originalFilename: 'clip.mp4',
    mimeType: 'video/mp4',
    fileSizeBytes,
    targetProjectId: 'project-1',
  };
}

function multipartSession(overrides: Partial<AssetUploadSessionEntity> = {}) {
  return {
    id: 'session-1',
    assetId: 'asset-1',
    storageKey: 'projects/project-1/originals/asset-1.mp4',
    multipartUploadId: 'upload-1',
    expectedSizeBytes: String(40 * MIB),
    expectedChecksumSha256: null,
    status: 'uploading',
    expiresAt: new Date(Date.now() + 60_000),
    createdBy: 'user-1',
    ...overrides,
  } as AssetUploadSessionEntity;
}

describe('AssetsService multipart uploads', () => {
  it('keeps a single presigned PUT for files up to 100 MiB', async () => {
    const { service, storage } = createService();

    const session = await service.createUploadSession(uploadDto(100 * MIB), 'user-1');

    expect(session.uploadUrl).toBe('https://r2.test/put');
    expect(session.multipart).toBeNull();
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('opens a multipart upload for files larger than 5 GB', async () => {
    const { service, storage } = createService();

    const session = await service.createUploadSession(uploadDto(6 * GIB), 'user-1');

    expect(storage.createMultipartUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^projects\/project-1\/originals\/.+\.mp4$/),
      'video/mp4',
    );
    expect(session.uploadUrl).toBeNull();
    expect(session.multipart).toEqual({ partSize: 16 * MIB, partCount: 384 });
  });

  it('aborts the multipart upload when the session cannot be saved', async () => {
    const { service, storage, dataSource } = createService();
    dataSource.transaction.mockRejectedValueOnce(new Error('db down'));

    await expect(service.createUploadSession(uploadDto(6 * GIB), 'user-1')).rejects.toThrow(
      'db down',
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(expect.any(String), 'upload-1');
  });

  it('presigns the requested parts and keeps the session open', async () => {
    const { service, sessionRepository } = createService();
    sessionRepository.findOne.mockResolvedValue(multipartSession());

    const result = await service.getUploadPartUrls(
      'asset-1',
      { uploadSessionId: 'session-1', partNumbers: [1, 3, 3] },
      'user-1',
    );

    expect(result.parts).toEqual([
      { partNumber: 1, url: 'https://r2.test/part-1' },
      { partNumber: 3, url: 'https://r2.test/part-3' },
    ]);
    expect(sessionRepository.update).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ status: 'uploading', expiresAt: expect.any(Date) }),
    );
  });

  it('rejects part numbers beyond the file', async () => {
    const { service, sessionRepository } = createService();
    sessionRepository.findOne.mockResolvedValue(multipartSession());

    await expect(
      service.getUploadPartUrls(
        'asset-1',
        { uploadSessionId: 'session-1', partNumbers: [4] },
        'user-1',
      ),
    ).rejects.toThrow('This upload has only 3 parts');
  });

  it('refuses to complete while parts are missing', async () => {
    const { service, storage, sessionRepository } = createService();
    sessionRepository.findOne.mockResolvedValue(multipartSession());
    storage.listMultipartParts.mockResolvedValue([
      { partNumber: 1, etag: '"a"', sizeBytes: 16 * MIB },
      { partNumber: 3, etag: '"c"', sizeBytes: 8 * MIB },
    ]);

    const error = await service
      .completeUpload('asset-1', { uploadSessionId: 'session-1' }, 'user-1')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('Upload is incomplete: missing parts 2');
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('assembles the parts before verifying the object', async () => {
    const { service, storage, sessionRepository } = createService();
    sessionRepository.findOne.mockResolvedValue(multipartSession());
    const parts = [
      { partNumber: 1, etag: '"a"', sizeBytes: 16 * MIB },
      { partNumber: 2, etag: '"b"', sizeBytes: 16 * MIB },
      { partNumber: 3, etag: '"c"', sizeBytes: 8 * MIB },
    ];
    storage.listMultipartParts.mockResolvedValue(parts);
    // Assembled with the wrong size, so completion stops right after the object check.
    storage.headObject.mockResolvedValueOnce(null).mockResolvedValueOnce({ sizeBytes: 1 });

    await expect(
      service.completeUpload('asset-1', { uploadSessionId: 'session-1' }, 'user-1'),
    ).rejects.toThrow('Uploaded object size does not match the declared size');
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      'projects/project-1/originals/asset-1.mp4',
      'upload-1',
      parts,
    );
  });

  it('does not assemble again when a previous complete call already did', async () => {
    const { service, storage, sessionRepository } = createService();
    sessionRepository.findOne.mockResolvedValue(multipartSession());
    storage.headObject.mockResolvedValue({ sizeBytes: 1 });

    await expect(
      service.completeUpload('asset-1', { uploadSessionId: 'session-1' }, 'user-1'),
    ).rejects.toThrow('Uploaded object size does not match the declared size');
    expect(storage.listMultipartParts).not.toHaveBeenCalled();
  });

  it('discards the uploaded parts on abort', async () => {
    const { service, storage, sessionRepository } = createService();
    sessionRepository.findOne.mockResolvedValue(multipartSession());

    await service.abortUpload('asset-1', 'session-1', 'user-1');

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'projects/project-1/originals/asset-1.mp4',
      'upload-1',
    );
    expect(storage.deleteObject).toHaveBeenCalled();
  });
});
