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
import {
  ImportQueueService,
  type ImportQueueJobData,
} from '../../infra/queue/import-queue.service';
import { MediaQueueService } from '../../infra/queue/media-queue.service';
import { IMPORT_JOB, IMPORT_QUEUE } from '../../infra/queue/queue.constants';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { refreshProjectMediaSummary } from '../media/project-media-summary';
import { GoogleDriveService } from './google-drive.service';

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  fileExtension?: string;
  fullFileExtension?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  imageMediaMetadata?: { width?: number; height?: number };
  videoMediaMetadata?: {
    width?: number;
    height?: number;
    durationMillis?: string;
  };
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
};

/** How often a running import touches its batch and current item, so the sweep sees it is alive. */
const HEARTBEAT_MS = 15_000;
/** Rows untouched for this long belong to a worker that died (container restart, OOM, SIGKILL). */
const STALE_MS = 2 * 60_000;
/** How often the worker looks for imports whose worker died mid-run. */
const STALE_SWEEP_MS = 60_000;
/** An item that took down its worker this many times is failed instead of retried. */
const MAX_ITEM_ATTEMPTS = 3;

@Injectable()
export class GoogleDriveImportWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(GoogleDriveImportWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<ImportQueueJobData>;
  private sweepTimer?: NodeJS.Timeout;

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
    private readonly importQueue: ImportQueueService,
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

    this.sweepTimer = setInterval(() => void this.recoverStaleImports(), STALE_SWEEP_MS);
    this.sweepTimer.unref();
    void this.recoverStaleImports();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    await this.worker?.close();
    await this.connection?.quit();
  }

  /**
   * Resumes imports whose worker died mid-run. Items left `importing` go back to `queued`
   * (or fail once they used every attempt), and batches that still have work but no live
   * BullMQ job, e.g. the job hit the stalled limit or Redis lost it, are enqueued again.
   * Completed items are never touched, so the new job continues where the old one stopped.
   */
  private async recoverStaleImports(): Promise<void> {
    try {
      const staleBefore = new Date(Date.now() - STALE_MS);
      const cancelled = await this.dataSource.query(
        `UPDATE asset_imports item SET status = 'cancelled', finished_at = now(), updated_at = now()
         FROM import_batches batch
         WHERE batch.id = item.batch_id AND batch.status = 'cancelled'
           AND item.status = 'importing' AND item.updated_at < $1
         RETURNING item.id`,
        [staleBefore],
      );
      const exhausted = await this.dataSource.query(
        `UPDATE asset_imports SET status = 'failed', error_code = 'WORKER_LOST',
           error_message = 'The worker stopped while importing this file', finished_at = now(),
           updated_at = now()
         WHERE status = 'importing' AND updated_at < $1 AND attempt_count >= $2
         RETURNING id`,
        [staleBefore, MAX_ITEM_ATTEMPTS],
      );
      const requeued = await this.dataSource.query(
        `UPDATE asset_imports SET status = 'queued', updated_at = now()
         WHERE status = 'importing' AND updated_at < $1
         RETURNING id`,
        [staleBefore],
      );
      const itemCounts = [cancelled, exhausted, requeued].map(
        (rows: unknown[][]) => rows[0].length,
      );
      if (itemCounts.some((count) => count > 0)) {
        this.logger.warn(
          `Recovered stale import items: ${itemCounts[2]} re-queued, ${itemCounts[1]} failed, ${itemCounts[0]} cancelled`,
        );
      }

      const batches = await this.batchRepository
        .createQueryBuilder('batch')
        .where('batch.status IN (:...statuses)', { statuses: ['queued', 'processing'] })
        .andWhere('batch.updated_at < :staleBefore', { staleBefore })
        .getMany();
      for (const batch of batches) {
        await this.resumeBatch(batch, staleBefore);
      }
    } catch (error) {
      this.logger.error(
        `Stale import sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resumeBatch(batch: ImportBatchEntity, staleBefore: Date): Promise<void> {
    try {
      if (batch.queueJobId && (await this.importQueue.hasPendingJob(batch.queueJobId))) {
        // Waiting behind other imports, or running; BullMQ moves a stalled active job back itself.
        return;
      }
      // Claims the batch, so several worker replicas sweeping at once enqueue it only once.
      const claimed = await this.batchRepository
        .createQueryBuilder()
        .update(ImportBatchEntity)
        .set({ updatedAt: () => 'now()' })
        .where('id = :id AND status IN (:...statuses) AND updated_at < :staleBefore', {
          id: batch.id,
          statuses: ['queued', 'processing'],
          staleBefore,
        })
        .execute();
      if (!claimed.affected) {
        return;
      }
      const remaining = await this.itemRepository.count({
        where: { batchId: batch.id, status: 'queued' },
      });
      if (remaining === 0) {
        await this.refreshBatchProgress(batch.id);
        return;
      }
      const queueJobId = await this.importQueue.addJob({
        batchId: batch.id,
        userId: batch.createdBy,
      });
      await this.batchRepository.update(batch.id, { queueJobId });
      this.logger.warn(
        `Resumed import batch ${batch.id} (${remaining} items left) as job ${queueJobId}`,
      );
    } catch (error) {
      this.logger.error(
        `Import batch ${batch.id} could not be resumed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Keeps updated_at fresh while this worker is alive, so recoverStaleImports leaves the rows alone. */
  private startHeartbeat(table: 'import_batches' | 'asset_imports', id: string): NodeJS.Timeout {
    const timer = setInterval(() => {
      this.dataSource
        .query(`UPDATE ${table} SET updated_at = now() WHERE id = $1`, [id])
        .catch((error: unknown) =>
          this.logger.warn(
            `Import heartbeat for ${table} ${id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }, HEARTBEAT_MS);
    timer.unref();
    return timer;
  }

  private async process(job: Job<ImportQueueJobData>): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: job.data.batchId, createdBy: job.data.userId },
    });
    if (!batch || ['completed', 'cancelled'].includes(batch.status)) {
      return;
    }
    const heartbeat = this.startHeartbeat('import_batches', batch.id);
    try {
      await this.runBatch(job, batch);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runBatch(job: Job<ImportQueueJobData>, batch: ImportBatchEntity): Promise<void> {
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
        where: { batchId: batch.id },
        order: { createdAt: 'ASC' },
      });
      const mediaItems = items.filter((item) => !this.isFolderMimeType(item.sourceMimeType));
      await this.batchRepository.update(batch.id, { totalItems: mediaItems.length });
      for (const item of mediaItems.filter((candidate) => candidate.status === 'queued')) {
        try {
          await this.importItem(batch, item, accessToken, job.data.userId);
        } catch (error) {
          await this.itemRepository.update(item.id, {
            status: 'failed',
            errorCode: 'IMPORT_FAILED',
            errorMessage: error instanceof Error ? error.message.slice(0, 4000) : 'Import failed',
            finishedAt: new Date(),
          });
        }
        await this.refreshBatchProgress(batch.id);
      }
      await this.refreshBatchProgress(batch.id);
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      const willRetry = job.attemptsMade + 1 < attempts;
      await this.batchRepository.update(batch.id, {
        status: willRetry ? 'queued' : 'failed',
        errorMessage: error instanceof Error ? error.message.slice(0, 4000) : 'Import failed',
      });
      throw error;
    }
  }

  private async refreshBatchProgress(batchId: string): Promise<void> {
    const items = await this.itemRepository.find({ where: { batchId } });
    const mediaItems = items.filter((item) => !this.isFolderMimeType(item.sourceMimeType));
    const completed = mediaItems.filter((item) => item.status === 'completed').length;
    const failed = mediaItems.filter((item) => item.status === 'failed').length;
    const active = mediaItems.some((item) => ['queued', 'importing'].includes(item.status));
    const total = mediaItems.length;
    const status = active
      ? 'processing'
      : failed === 0
        ? 'completed'
        : completed > 0
          ? 'partial'
          : 'failed';
    await this.batchRepository.update(batchId, {
      totalItems: total,
      completedItems: completed,
      failedItems: failed,
      progressPercent: total ? Math.round(((completed + failed) / total) * 100) : 100,
      status,
    });
  }

  private async importItem(
    batch: ImportBatchEntity,
    item: AssetImportEntity,
    accessToken: string,
    userId: string,
  ) {
    const claimed = await this.itemRepository
      .createQueryBuilder()
      .update(AssetImportEntity)
      .set({
        status: 'importing',
        startedAt: new Date(),
        attemptCount: () => 'attempt_count + 1',
        errorCode: null,
        errorMessage: null,
      })
      .where('id = :id AND status = :status', { id: item.id, status: 'queued' })
      .execute();
    if (!claimed.affected) {
      // Another job of this batch (a retry or a resumed job) already took or cancelled it.
      return;
    }
    const heartbeat = this.startHeartbeat('asset_imports', item.id);
    try {
      await this.downloadItem(batch, item, accessToken, userId);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async downloadItem(
    batch: ImportBatchEntity,
    item: AssetImportEntity,
    accessToken: string,
    userId: string,
  ) {
    const file = await this.getFile(accessToken, item.sourceFileId ?? '');
    const metadata = this.extractDriveMetadata(file);
    await this.itemRepository.update(item.id, {
      sourceName: this.withExtension(
        file.name,
        file.mimeType,
        file.fileExtension ?? file.fullFileExtension,
      ).slice(0, 255),
      sourceMimeType: file.mimeType,
      sourceSizeBytes: file.size ?? null,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      sourceDurationSeconds: metadata.durationSeconds,
      sourceCreator: metadata.creator,
      sourceModifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
      sourceRevisionId: file.headRevisionId ?? null,
    });
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      throw new Error('Folder discovery must be completed before importing this item');
    }
    if (!this.isSupportedMedia(file.mimeType)) {
      throw new Error('Only image and video files can be imported from Google Drive');
    }
    const existing = await this.findExistingProjectMedia(batch.projectId, file.id);
    if (existing && batch.duplicatePolicy === 'reuse_existing') {
      await this.itemRepository.update(item.id, {
        assetId: existing.assetId,
        sourceRevisionId: file.headRevisionId ?? null,
        resolution: 'reused',
        status: 'completed',
        finishedAt: new Date(),
      });
      return;
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
    const originalFilename = this.withExtension(
      file.name,
      file.mimeType,
      file.fileExtension ?? file.fullFileExtension,
    );
    const storageKey = `projects/${batch.projectId}/originals/${assetId}/${this.safeName(originalFilename)}`;
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

    let reusedDuringTransaction = false;
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `google-drive:${batch.projectId}:${file.id}`,
      ]);
      const currentExisting = await this.findExistingProjectMedia(
        batch.projectId,
        file.id,
        manager,
      );
      if (batch.duplicatePolicy === 'reuse_existing' && currentExisting) {
        reusedDuringTransaction = true;
        await manager.update(AssetImportEntity, item.id, {
          assetId: currentExisting.assetId,
          sourceRevisionId: file.headRevisionId ?? null,
          resolution: 'reused',
          status: 'completed',
          finishedAt: new Date(),
        });
        return;
      }
      const overwriteExisting =
        batch.duplicatePolicy === 'overwrite_existing' ? currentExisting : null;
      await manager.insert(AssetEntity, {
        id: assetId,
        assetType,
        originalFilename,
        extension: originalFilename.split('.').pop()?.slice(0, 20) ?? null,
        mimeType: file.mimeType,
        checksumSha256: null,
        fileSizeBytes: String(contentLength),
        storageProvider: 'r2',
        originalBucket: this.config.getOrThrow<string>('R2_BUCKET'),
        originalStorageKey: storageKey,
        processingStatus: 'uploaded',
        processingError: null,
        sourceType: 'google_drive',
        googleDriveFileId: file.id,
        sourceMetadata: {
          sourceFileId: file.id,
          ...(file.headRevisionId ? { revisionId: file.headRevisionId } : {}),
          ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
          ...(metadata.creator ? { driveCreator: metadata.creator } : {}),
          ...(metadata.width !== null ? { driveWidth: metadata.width } : {}),
          ...(metadata.height !== null ? { driveHeight: metadata.height } : {}),
          ...(metadata.durationSeconds ? { durationSeconds: metadata.durationSeconds } : {}),
        },
        createdBy: userId,
      });
      if (overwriteExisting) {
        await manager.update(ProjectMediaEntity, overwriteExisting.projectMediaId, { assetId });
      } else {
        await manager.insert(ProjectMediaEntity, {
          id: uuidv7(),
          projectId: batch.projectId,
          assetId,
          sortOrder: 0,
          caption: null,
          createdBy: userId,
        });
      }
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
        sourceName: originalFilename,
        sourceMimeType: file.mimeType,
        sourceSizeBytes: file.size ?? null,
        sourceWidth: metadata.width,
        sourceHeight: metadata.height,
        sourceDurationSeconds: metadata.durationSeconds,
        sourceCreator: metadata.creator,
        sourceModifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
        sourceRevisionId: file.headRevisionId ?? null,
        resolution: overwriteExisting ? 'overwritten' : 'created',
        status: 'completed',
        finishedAt: new Date(),
      });
      await refreshProjectMediaSummary(manager, batch.projectId);
    });

    if (reusedDuringTransaction) {
      try {
        await this.storage.deleteObject(storageKey);
      } catch (error) {
        this.logger.warn(
          `Failed to clean up duplicate Drive object ${storageKey}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
      return;
    }

    await this.mediaQueue.addProcessingJob({
      eventId: renderJobId,
      assetId,
      renderJobId,
      userId,
    });
  }

  private async getFile(accessToken: string, fileId: string): Promise<DriveFile> {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,fileExtension,fullFileExtension,modifiedTime,headRevisionId,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),owners(displayName,emailAddress)&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Google Drive metadata lookup failed with ${response.status}`);
    }
    const payload = (await response.json()) as DriveFile;
    this.logger.log(
      `[Google Drive API] import file metadata: ${JSON.stringify({
        fileId,
        id: payload.id,
        name: payload.name,
        mimeType: payload.mimeType,
        size: payload.size,
        fileExtension: payload.fileExtension,
        fullFileExtension: payload.fullFileExtension,
        modifiedTime: payload.modifiedTime,
        headRevisionId: payload.headRevisionId,
      })}`,
    );
    return payload;
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
      sourceName: this.withExtension(
        root.name,
        root.mimeType,
        root.fileExtension ?? root.fullFileExtension,
      ),
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
        sourceName: this.withExtension(
          file.name,
          file.mimeType,
          file.fileExtension ?? file.fullFileExtension,
        ).slice(0, 255),
        sourceMimeType: file.mimeType,
        sourceSizeBytes: file.size ?? null,
        sourceRevisionId: file.headRevisionId ?? null,
        ...this.toImportMetadata(file),
        resolution: null,
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
        fields:
          'nextPageToken,files(id,name,mimeType,size,fileExtension,fullFileExtension,modifiedTime,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),owners(displayName,emailAddress))',
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
      this.logger.log(
        `[Google Drive API] import folder page: ${JSON.stringify({
          parentId,
          driveId,
          fileCount: page.files?.length ?? 0,
          files: (page.files ?? []).map((file) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            fileExtension: file.fileExtension,
            fullFileExtension: file.fullFileExtension,
            modifiedTime: file.modifiedTime,
          })),
        })}`,
      );
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  private safeName(value: string): string {
    return value.replace(/[^\w.\-]/g, '_').slice(0, 180) || 'file';
  }

  private withExtension(name: string, mimeType: string, driveExtension?: string): string {
    if (name.lastIndexOf('.') > 0) {
      return name;
    }
    if (driveExtension) {
      return `${name}.${driveExtension.replace(/^\./, '')}`;
    }
    const extensions: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/quicktime': 'mp4',
      'video/webm': 'webm',
      'video/x-matroska': 'mkv',
    };
    const extension = extensions[mimeType.toLowerCase()];
    return extension ? `${name}.${extension}` : name;
  }

  private extractDriveMetadata(file: DriveFile): {
    width: number | null;
    height: number | null;
    durationSeconds: string | null;
    creator: string | null;
  } {
    const image = file.imageMediaMetadata;
    const video = file.videoMediaMetadata;
    const durationMillis = video?.durationMillis ? Number(video.durationMillis) : NaN;
    const creator = file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? null;
    return {
      width: image?.width ?? video?.width ?? null,
      height: image?.height ?? video?.height ?? null,
      durationSeconds: Number.isFinite(durationMillis) ? String(durationMillis / 1000) : null,
      creator,
    };
  }

  private toImportMetadata(file: DriveFile) {
    const metadata = this.extractDriveMetadata(file);
    return {
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      sourceDurationSeconds: metadata.durationSeconds,
      sourceCreator: metadata.creator,
      sourceModifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
    };
  }

  private isSupportedMedia(mimeType: string): boolean {
    return mimeType.startsWith('image/') || mimeType.startsWith('video/');
  }

  private isFolderMimeType(mimeType: string | null): boolean {
    return (
      mimeType === 'application/vnd.google-apps.folder' || Boolean(mimeType?.includes('folder'))
    );
  }

  private async findExistingProjectMedia(
    projectId: string,
    fileId: string,
    manager: import('typeorm').EntityManager = this.dataSource.manager,
  ): Promise<{ assetId: string; projectMediaId: string } | null> {
    const row = await manager
      .createQueryBuilder()
      .select('asset.id', 'assetId')
      .addSelect('media.id', 'projectMediaId')
      .from(ProjectMediaEntity, 'media')
      .innerJoin(AssetEntity, 'asset', 'asset.id = media.asset_id')
      .where('media.project_id = :projectId', { projectId })
      .andWhere('asset.google_drive_file_id = :fileId', { fileId })
      .orderBy('media.created_at', 'DESC')
      .getRawOne<{ assetId: string; projectMediaId: string }>();
    return row ?? null;
  }
}
