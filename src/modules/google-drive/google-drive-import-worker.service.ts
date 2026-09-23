import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Readable } from 'node:stream';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AssetImportEntity } from '../../database/entities/asset-import.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { GoogleDriveConnectionEntity } from '../../database/entities/google-drive-connection.entity';
import { ImportBatchEntity } from '../../database/entities/import-batch.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import type { ImportQueueJobData } from '../../infra/queue/import-queue.service';
import { MediaQueueService } from '../../infra/queue/media-queue.service';
import { IMPORT_JOB, IMPORT_QUEUE } from '../../infra/queue/queue.constants';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { GoogleDriveService } from './google-drive.service';

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
};

@Injectable()
export class GoogleDriveImportWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(GoogleDriveImportWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<ImportQueueJobData>;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(ImportBatchEntity)
    private readonly batchRepository: Repository<ImportBatchEntity>,
    @InjectRepository(AssetImportEntity)
    private readonly itemRepository: Repository<AssetImportEntity>,
    @InjectRepository(GoogleDriveConnectionEntity)
    private readonly connectionRepository: Repository<GoogleDriveConnectionEntity>,
    @InjectRepository(RenderProfileEntity)
    private readonly renderProfileRepository: Repository<RenderProfileEntity>,
    private readonly googleDrive: GoogleDriveService,
    private readonly mediaQueue: MediaQueueService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  start(): void {
    if (this.worker) {
      return;
    }
    this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<ImportQueueJobData>(
      IMPORT_QUEUE,
      async (job) => {
        if (job.name !== IMPORT_JOB) {
          throw new Error(`Unsupported import job ${job.name}`);
        }
        await this.process(job);
      },
      {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
        concurrency: 1,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Import job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async process(job: Job<ImportQueueJobData>): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: job.data.batchId, createdBy: job.data.userId },
    });
    if (!batch || ['completed', 'failed', 'cancelled'].includes(batch.status)) {
      return;
    }
    await this.batchRepository.update(batch.id, { status: 'processing' });
    const connection = batch.connectionId
      ? await this.connectionRepository.findOne({ where: { id: batch.connectionId } })
      : null;
    if (!connection) {
      throw new Error('Google Drive connection is missing');
    }

    try {
      const accessToken = await this.googleDrive.getDriveAccessToken(
        connection.id,
        job.data.userId,
      );
      const queuedItems = await this.itemRepository.find({
        where: { batchId: batch.id, status: 'queued' },
        order: { createdAt: 'ASC' },
      });
      for (const item of queuedItems) {
        const root = await this.getFile(accessToken, item.sourceFileId ?? '');
        if (root.mimeType === 'application/vnd.google-apps.folder') {
          await this.expandFolder(batch, item, root, accessToken);
        }
      }
      const items = await this.itemRepository.find({
        where: { batchId: batch.id, status: 'queued' },
        order: { createdAt: 'ASC' },
      });
      await this.batchRepository.update(batch.id, { totalItems: items.length });
      let completed = 0;
      let failed = 0;
      for (const item of items) {
        try {
          await this.importItem(batch, item, accessToken, job.data.userId);
          completed += 1;
        } catch (error) {
          failed += 1;
          await this.itemRepository.update(item.id, {
            status: 'failed',
            errorCode: 'IMPORT_FAILED',
            errorMessage: error instanceof Error ? error.message.slice(0, 4000) : 'Import failed',
            finishedAt: new Date(),
          });
        }
        await this.batchRepository.update(batch.id, {
          completedItems: completed,
          failedItems: failed,
          progressPercent: items.length
            ? Math.round(((completed + failed) / items.length) * 100)
            : 100,
        });
      }
      await this.batchRepository.update(batch.id, {
        status: failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed',
      });
    } catch (error) {
      await this.batchRepository.update(batch.id, {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message.slice(0, 4000) : 'Import failed',
      });
      throw error;
    }
  }

  private async importItem(
    batch: ImportBatchEntity,
    item: AssetImportEntity,
    accessToken: string,
    userId: string,
  ) {
    await this.itemRepository.update(item.id, { status: 'importing', startedAt: new Date() });
    const file = await this.getFile(accessToken, item.sourceFileId ?? '');
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      throw new Error('Folder discovery must be completed before importing this item');
    }
    if (!this.isSupportedMedia(file.mimeType)) {
      throw new Error('Only image and video files can be imported from Google Drive');
    }
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Google Drive download failed with ${response.status}`);
    }
    const headerContentLength = Number(response.headers.get('content-length'));
    const metadataContentLength = Number(file.size);
    const contentLength =
      Number.isSafeInteger(metadataContentLength) && metadataContentLength > 0
        ? metadataContentLength
        : Number.isSafeInteger(headerContentLength) && headerContentLength > 0
          ? headerContentLength
          : undefined;
    if (contentLength === undefined) {
      throw new Error('Google Drive response did not include a valid file size');
    }

    const assetId = uuidv7();
    const storageKey = `imports/${userId}/${assetId}/${this.safeName(file.name)}`;
    await this.storage.putObject(
      storageKey,
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      file.mimeType,
      contentLength,
    );
    const assetType = file.mimeType.startsWith('video/') ? 'video' : 'image';
    const renderJobId = uuidv7();
    const profile = await this.renderProfileRepository.findOne({
      where: { code: 'default', isActive: true },
      order: { profileVersion: 'DESC' },
    });

    await this.dataSource.transaction(async (manager) => {
      await manager.insert(AssetEntity, {
        id: assetId,
        assetType,
        originalFilename: file.name,
        extension: file.name.split('.').pop()?.slice(0, 20) ?? null,
        mimeType: file.mimeType,
        checksumSha256: null,
        fileSizeBytes: String(contentLength),
        storageProvider: 'r2',
        originalBucket: this.config.getOrThrow<string>('R2_BUCKET'),
        originalStorageKey: storageKey,
        processingStatus: 'uploaded',
        processingError: null,
        sourceType: 'google_drive',
        sourceMetadata: { sourceFileId: file.id, modifiedTime: file.modifiedTime },
        createdBy: userId,
      });
      await manager.insert(ProjectMediaEntity, {
        id: uuidv7(),
        projectId: batch.projectId,
        assetId,
        sortOrder: 0,
        caption: null,
        createdBy: userId,
      });
      await manager.insert(MediaRenderJobEntity, {
        id: renderJobId,
        assetId,
        renderProfileId: profile?.id ?? null,
        renderBatchId: null,
        renderVersion: profile?.profileVersion ?? 1,
        queueJobId: null,
        dedupeKey: `${assetId}:import:${profile?.id ?? 'legacy'}:${profile?.profileVersion ?? 1}`,
        status: 'queued',
        progressPercent: 0,
        progressMessage: 'Queued after Drive import',
        attemptCount: 0,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdBy: userId,
      });
      await manager.update(AssetImportEntity, item.id, {
        assetId,
        sourceName: file.name,
        sourceMimeType: file.mimeType,
        sourceSizeBytes: file.size ?? null,
        status: 'completed',
        finishedAt: new Date(),
      });
    });

    await this.mediaQueue.addProcessingJob({
      eventId: renderJobId,
      assetId,
      renderJobId,
      userId,
    });
  }

  private async getFile(accessToken: string, fileId: string): Promise<DriveFile> {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Google Drive metadata lookup failed with ${response.status}`);
    }
    return (await response.json()) as DriveFile;
  }

  private async expandFolder(
    batch: ImportBatchEntity,
    rootItem: AssetImportEntity,
    root: DriveFile,
    accessToken: string,
  ): Promise<void> {
    const discovered = new Map<string, DriveFile>();
    const pending = [root.id];
    const maxFiles = 10_000;

    while (pending.length > 0) {
      const parentId = pending.shift();
      if (!parentId) {
        continue;
      }
      const files = await this.listChildren(accessToken, parentId, batch.sourceDriveId);
      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          pending.push(file.id);
          continue;
        }
        if (!this.isSupportedMedia(file.mimeType)) {
          continue;
        }
        if (!discovered.has(file.id)) {
          discovered.set(file.id, file);
        }
        if (discovered.size >= maxFiles) {
          throw new Error(`Google Drive folder exceeds the ${maxFiles} file limit`);
        }
      }
    }

    await this.itemRepository.update(rootItem.id, {
      status: 'completed',
      sourceName: root.name,
      sourceMimeType: root.mimeType,
      finishedAt: new Date(),
    });

    for (const file of discovered.values()) {
      const existing = await this.itemRepository.findOne({
        where: { batchId: batch.id, sourceFileId: file.id },
      });
      if (existing) {
        continue;
      }
      await this.itemRepository.insert({
        id: uuidv7(),
        batchId: batch.id,
        projectId: batch.projectId,
        assetId: null,
        connectionId: batch.connectionId,
        sourceType: 'google_drive',
        sourceDriveId: batch.sourceDriveId,
        sourceFileId: file.id,
        sourceRevisionId: null,
        sourceName: file.name.slice(0, 255),
        sourceMimeType: file.mimeType,
        sourceSizeBytes: file.size ?? null,
        status: 'queued',
        attemptCount: 0,
        errorCode: null,
        errorMessage: null,
        queueJobId: null,
        startedAt: null,
        finishedAt: null,
      });
    }
  }

  private async listChildren(
    accessToken: string,
    parentId: string,
    driveId: string | null,
  ): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${parentId.replaceAll("'", "\\'")}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
        pageSize: '1000',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
      });
      if (driveId) {
        params.set('corpora', 'drive');
        params.set('driveId', driveId);
      }
      if (pageToken) {
        params.set('pageToken', pageToken);
      }
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new Error(`Google Drive folder listing failed with ${response.status}`);
      }
      const page = (await response.json()) as {
        nextPageToken?: string;
        files?: DriveFile[];
      };
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  private safeName(value: string): string {
    return value.replace(/[^\w.\-]/g, '_').slice(0, 180) || 'file';
  }

  private isSupportedMedia(mimeType: string): boolean {
    return mimeType.startsWith('image/') || mimeType.startsWith('video/');
  }
}
