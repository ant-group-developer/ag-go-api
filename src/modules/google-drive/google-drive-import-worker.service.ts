import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DelayedError, Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { Readable } from 'node:stream';
import { DataSource, In, Not, Repository } from 'typeorm';
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
import {
  IMPORT_DISCOVERY_JOB,
  IMPORT_DISCOVERY_QUEUE,
  IMPORT_JOB,
  IMPORT_QUEUE,
} from '../../infra/queue/queue.constants';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { AuditService } from '../audit/audit.service';
import { refreshProjectMediaSummary } from '../media/project-media-summary';
import { DriveAccessToken, DriveAuthError, driveFetch, withIdleTimeout } from './drive-http';
import { GoogleDriveService } from './google-drive.service';
import { IMPORT_FINISHED_AUDIT_ACTIONS, recordImportAudit } from './import-batch-audit';

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
/**
 * STALE_MS as a Postgres interval. Staleness is compared with now() on the database, the clock
 * the heartbeats write with, so workers on hosts whose clocks drift agree on it.
 */
const STALE_INTERVAL = `${STALE_MS} milliseconds`;
/** How often the worker looks for imports whose worker died mid-run. */
const STALE_SWEEP_MS = 60_000;
/** An item that took down its worker this many times is failed instead of retried. */
const MAX_ITEM_ATTEMPTS = 3;
/** How long Drive may take to start answering a download. */
const DOWNLOAD_RESPONSE_TIMEOUT_MS = 30_000;
/** A download (or its upload to R2) that moves no data for this long is treated as stalled. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** Batches whose folders are listed at once, ahead of their import. */
const DISCOVERY_CONCURRENCY = 3;
/** A discovery lock not renewed for this long belongs to a worker that died. */
const DISCOVERY_LOCK_MS = 60_000;
/** How often the import job checks whether the discovery job released the batch. */
const DISCOVERY_LOCK_POLL_MS = 2_000;
/** How long an import job waits before checking again whether the batch ahead of it finished. */
const BATCH_AHEAD_POLL_MS = 5_000;
const RENEW_LOCK_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end; return 0";
const RELEASE_LOCK_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0";

@Injectable()
export class GoogleDriveImportWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(GoogleDriveImportWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<ImportQueueJobData>;
  private discoveryWorker?: Worker<ImportQueueJobData>;
  private sweepTimer?: NodeJS.Timeout;
  /** Set on shutdown: the running batch stops after its current file and hands its job back. */
  private stopping = false;

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
    private readonly auditService: AuditService,
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
      async (job, token) => {
        if (job.name !== IMPORT_JOB) {
          throw new Error(`Unsupported import job ${job.name}`);
        }
        await this.process(job, token);
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
    this.discoveryWorker = new Worker<ImportQueueJobData>(
      IMPORT_DISCOVERY_QUEUE,
      async (job) => {
        if (job.name !== IMPORT_DISCOVERY_JOB) {
          throw new Error(`Unsupported import discovery job ${job.name}`);
        }
        await this.discover(job);
      },
      {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
        concurrency: DISCOVERY_CONCURRENCY,
      },
    );
    this.discoveryWorker.on('failed', (job, error) => {
      // The import job lists the folders again when it starts.
      this.logger.warn(`Import discovery job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });

    this.sweepTimer = setInterval(() => void this.recoverStaleImports(), STALE_SWEEP_MS);
    this.sweepTimer.unref();
    void this.recoverStaleImports();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    await this.worker?.close();
    await this.discoveryWorker?.close();
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
      const cancelled = await this.dataSource.query(
        `UPDATE asset_imports item SET status = 'cancelled', finished_at = now(), updated_at = now()
         FROM import_batches batch
         WHERE batch.id = item.batch_id AND batch.status = 'cancelled'
           AND item.status = 'importing' AND item.updated_at < now() - $1::interval
         RETURNING item.id`,
        [STALE_INTERVAL],
      );
      const exhausted = await this.dataSource.query(
        `UPDATE asset_imports SET status = 'failed', error_code = 'WORKER_LOST',
           error_message = 'The worker stopped while importing this file', finished_at = now(),
           updated_at = now()
         WHERE status = 'importing' AND updated_at < now() - $1::interval AND attempt_count >= $2
         RETURNING id`,
        [STALE_INTERVAL, MAX_ITEM_ATTEMPTS],
      );
      const requeued = await this.dataSource.query(
        `UPDATE asset_imports SET status = 'queued', updated_at = now()
         WHERE status = 'importing' AND updated_at < now() - $1::interval
         RETURNING id`,
        [STALE_INTERVAL],
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
        .andWhere('batch.updated_at < now() - CAST(:staleAfter AS interval)', {
          staleAfter: STALE_INTERVAL,
        })
        .getMany();
      for (const batch of batches) {
        await this.resumeBatch(batch);
      }
    } catch (error) {
      this.logger.error(
        `Stale import sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resumeBatch(batch: ImportBatchEntity): Promise<void> {
    try {
      if (batch.queueJobId && (await this.importQueue.hasPendingJob(batch.queueJobId))) {
        // Waiting behind other imports, or running; BullMQ moves a stalled active job back itself.
        // A waiting batch whose folders were never listed (its discovery job was lost) gets one.
        if (batch.status === 'queued' && (await this.findUndiscoveredRoots(batch.id)).length > 0) {
          await this.importQueue.addDiscoveryJob({ batchId: batch.id, userId: batch.createdBy });
        }
        return;
      }
      // Claims the batch, so several worker replicas sweeping at once enqueue it only once.
      const claimed = await this.batchRepository
        .createQueryBuilder()
        .update(ImportBatchEntity)
        .set({ updatedAt: () => 'now()' })
        .where(
          'id = :id AND status IN (:...statuses) AND updated_at < now() - CAST(:staleAfter AS interval)',
          { id: batch.id, statuses: ['queued', 'processing'], staleAfter: STALE_INTERVAL },
        )
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

  private async process(job: Job<ImportQueueJobData>, token?: string): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: job.data.batchId, createdBy: job.data.userId },
    });
    // A paused batch gets a new job when it is resumed.
    if (!batch || ['completed', 'cancelled', 'paused'].includes(batch.status)) {
      return;
    }
    // After a restart the job of the interrupted batch only becomes runnable once BullMQ sees it
    // stalled, so the next waiting job would start first and two batches would run side by side.
    if (await this.hasBatchAhead(batch)) {
      await this.postpone(job, token, BATCH_AHEAD_POLL_MS);
    }
    const heartbeat = this.startHeartbeat('import_batches', batch.id);
    let interrupted: boolean;
    try {
      interrupted = await this.runBatch(job, batch);
    } finally {
      clearInterval(heartbeat);
    }
    if (interrupted) {
      // The batch stays `processing`, so the next worker continues it before any other batch.
      this.logger.log(`Import batch ${batch.id} stopped for shutdown; its job resumes on restart`);
      await this.postpone(job, token, 0);
    }
  }

  /**
   * Another batch was started and has not finished, e.g. one cut off by a restart whose job is
   * waiting to run again. It goes first, so imports keep running one at a time. Between two
   * started batches the older one goes first, so they never keep deferring to each other.
   */
  private async hasBatchAhead(batch: ImportBatchEntity): Promise<boolean> {
    const query = this.batchRepository
      .createQueryBuilder('batch')
      .where("batch.status = 'processing' AND batch.id <> :id", { id: batch.id });
    if (batch.status === 'processing') {
      query.andWhere('(batch.created_at, batch.id) < (:createdAt, :id)', {
        createdAt: batch.createdAt,
      });
    }
    return query.getExists();
  }

  /** Hands the job back to the queue without using up an attempt. */
  private async postpone(
    job: Job<ImportQueueJobData>,
    token: string | undefined,
    delayMs: number,
  ): Promise<never> {
    await job.moveToDelayed(Date.now() + delayMs, token);
    throw new DelayedError();
  }

  /**
   * Lists the folders of a batch still waiting for the import worker, so its file count and
   * size show before its turn. A batch already running lists them in its own job.
   */
  private async discover(job: Job<ImportQueueJobData>): Promise<void> {
    const batch = await this.batchRepository.findOne({
      where: { id: job.data.batchId, createdBy: job.data.userId },
    });
    if (
      !batch?.connectionId ||
      !['queued', 'paused'].includes(batch.status) ||
      (await this.findUndiscoveredRoots(batch.id)).length === 0
    ) {
      return;
    }
    const connectionId = batch.connectionId;
    const token = new DriveAccessToken(() =>
      this.googleDrive.refreshDriveAccessToken(connectionId, job.data.userId),
    );
    await this.withDiscoveryLock(batch.id, false, async () => {
      if (await this.discoverFolders(batch, token)) {
        await this.refreshBatchProgress(batch.id);
      }
    });
  }

  /**
   * Runs folder discovery of a batch under its Redis lock, so the discovery job and the import
   * job never expand the same folder at once (which would add its files twice). With `wait`
   * the caller polls until the lock is free; without it, it gives up and returns undefined.
   */
  private async withDiscoveryLock<T>(
    batchId: string,
    wait: boolean,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    const redis = this.connection;
    if (!redis) {
      throw new Error('Import worker is not started');
    }
    const key = `${this.config.getOrThrow<string>('QUEUE_PREFIX')}:import-discovery-lock:${batchId}`;
    const owner = uuidv7();
    while (!(await redis.set(key, owner, 'PX', DISCOVERY_LOCK_MS, 'NX'))) {
      if (!wait) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, DISCOVERY_LOCK_POLL_MS));
    }
    const renewal = setInterval(() => {
      redis
        .eval(RENEW_LOCK_SCRIPT, 1, key, owner, DISCOVERY_LOCK_MS)
        .catch((error: unknown) =>
          this.logger.warn(
            `Import discovery lock renewal for ${batchId} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    }, HEARTBEAT_MS);
    renewal.unref();
    try {
      return await run();
    } finally {
      clearInterval(renewal);
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, owner).catch(() => undefined);
    }
  }

  /** Returns true when the worker is shutting down and the batch still has files left. */
  private async runBatch(job: Job<ImportQueueJobData>, batch: ImportBatchEntity): Promise<boolean> {
    let interrupted = false;
    await this.batchRepository.update(
      { id: batch.id, status: Not(In(['cancelled', 'paused'])) },
      { status: 'processing' },
    );
    try {
      const connection = batch.connectionId
        ? await this.connectionRepository.findOne({ where: { id: batch.connectionId } })
        : null;
      if (!connection) {
        throw new Error('Google Drive connection is missing');
      }
      const token = new DriveAccessToken(() =>
        this.googleDrive.refreshDriveAccessToken(connection.id, job.data.userId),
      );
      // Retries the batch early when Drive cannot be reached at all.
      await token.get();

      if (
        !(await this.withDiscoveryLock(batch.id, true, () => this.discoverFolders(batch, token)))
      ) {
        return false;
      }
      await this.refreshBatchProgress(batch.id);
      const queuedItems = await this.itemRepository.find({
        where: { batchId: batch.id, status: 'queued' },
        order: { createdAt: 'ASC' },
      });
      for (const item of queuedItems) {
        if (this.isFolderMimeType(item.sourceMimeType)) {
          continue;
        }
        if (this.stopping) {
          interrupted = true;
          break;
        }
        let claimed = true;
        try {
          claimed = await this.importItem(batch, item, token, job.data.userId);
        } catch (error) {
          if (error instanceof DriveAuthError) {
            // Not this file's fault: put it back and let the batch retry once Drive answers.
            await this.itemRepository.update(
              { id: item.id, status: 'importing' },
              { status: 'queued' },
            );
            throw error;
          }
          await this.itemRepository.update(item.id, {
            status: 'failed',
            errorCode: 'IMPORT_FAILED',
            errorMessage: error instanceof Error ? error.message.slice(0, 4000) : 'Import failed',
            finishedAt: new Date(),
          });
        }
        if (!claimed) {
          if (await this.isStopped(batch.id)) {
            break;
          }
          continue;
        }
        await this.refreshBatchProgress(batch.id);
      }
      await this.refreshBatchProgress(batch.id);
      return interrupted;
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      const willRetry = job.attemptsMade + 1 < attempts;
      await this.batchRepository.update(
        { id: batch.id, status: Not(In(['cancelled', 'paused'])) },
        {
          status: willRetry ? 'queued' : 'failed',
          errorMessage: error instanceof Error ? error.message.slice(0, 4000) : 'Import failed',
        },
      );
      throw error;
    }
  }

  /**
   * Expands the batch's queued folder sources into their media files. A source that cannot be
   * read fails on its own and the rest of the batch continues. Returns false when the batch
   * was cancelled meanwhile; its remaining files are then cancelled too.
   */
  private async discoverFolders(
    batch: ImportBatchEntity,
    token: DriveAccessToken,
  ): Promise<boolean> {
    const roots = await this.findUndiscoveredRoots(batch.id);
    for (const root of roots) {
      if (await this.isCancelled(batch.id)) {
        break;
      }
      try {
        const file = await this.getFile(token, root.sourceFileId ?? '');
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          await this.expandFolder(batch, root, file, token);
        }
      } catch (error) {
        if (error instanceof DriveAuthError) {
          throw error;
        }
        await this.itemRepository.update(
          { id: root.id, status: 'queued' },
          {
            status: 'failed',
            errorCode: 'DISCOVERY_FAILED',
            errorMessage: error instanceof Error ? error.message.slice(0, 4000) : 'Import failed',
            finishedAt: new Date(),
          },
        );
      }
    }
    if (await this.isCancelled(batch.id)) {
      await this.itemRepository.update(
        { batchId: batch.id, status: 'queued' },
        { status: 'cancelled' },
      );
      await this.refreshBatchProgress(batch.id);
      return false;
    }
    return true;
  }

  /**
   * Sources of the batch that may still be folders to expand. Files picked directly and files
   * found in a folder already carry their MIME type, so a resumed batch does not look up
   * thousands of files again just to find its folders.
   */
  private findUndiscoveredRoots(batchId: string): Promise<AssetImportEntity[]> {
    return this.itemRepository
      .createQueryBuilder('item')
      .where('item.batch_id = :batchId AND item.status = :status', { batchId, status: 'queued' })
      .andWhere("(item.source_mime_type IS NULL OR item.source_mime_type LIKE '%folder%')")
      .orderBy('item.created_at', 'ASC')
      .getMany();
  }

  private async isCancelled(batchId: string): Promise<boolean> {
    return this.batchRepository.exists({ where: { id: batchId, status: 'cancelled' } });
  }

  /** Cancelled or paused: the worker must not start another file of the batch. */
  private async isStopped(batchId: string): Promise<boolean> {
    return this.batchRepository.exists({
      where: { id: batchId, status: In(['cancelled', 'paused']) },
    });
  }

  /**
   * Recounts the batch from its items in one query. An expanded folder is not a file of its
   * own, a folder still waiting to be expanded is pending and one that could not be read
   * counts as failed. A cancelled batch keeps its status, and so does a queued or paused one
   * while it still has files left (its folders can be listed before its turn).
   */
  private async refreshBatchProgress(batchId: string): Promise<void> {
    const [counts] = (await this.dataSource.query(
      `SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE status IN ('queued', 'importing'))::int AS active
       FROM asset_imports
       WHERE batch_id = $1
         AND NOT (COALESCE(source_mime_type, '') LIKE '%folder%'
           AND status IN ('completed', 'cancelled'))`,
      [batchId],
    )) as Array<{ total: number; completed: number; failed: number; active: number }>;
    const { total, completed, failed, active } = counts;
    const status =
      active > 0 ? 'processing' : failed === 0 ? 'completed' : completed > 0 ? 'partial' : 'failed';
    // `previous` locks the row first, so when two jobs refresh the same batch at once the second
    // one sees the status the first wrote and only one of them reports the finish.
    const [transition] = (await this.dataSource.query(
      `WITH previous AS (
         SELECT id, status FROM import_batches WHERE id = $1 FOR UPDATE
       ), updated AS (
         UPDATE import_batches batch
         SET total_items = $2, completed_items = $3, failed_items = $4, progress_percent = $5,
           status = CASE
             WHEN batch.status = 'cancelled' OR (batch.status IN ('queued', 'paused') AND $7::boolean)
               THEN batch.status
             ELSE $6::varchar
           END,
           updated_at = now()
         FROM previous
         WHERE batch.id = previous.id
         RETURNING previous.status AS "previousStatus", batch.status, batch.project_id AS "projectId",
           batch.created_by AS "createdBy"
       )
       SELECT * FROM updated`,
      [
        batchId,
        total,
        completed,
        failed,
        total ? Math.round(((completed + failed) / total) * 100) : 100,
        status,
        active > 0,
      ],
    )) as Array<{ previousStatus: string; status: string; projectId: string; createdBy: string }>;
    const finishedAction = transition && IMPORT_FINISHED_AUDIT_ACTIONS[transition.status];
    if (finishedAction && transition.previousStatus !== transition.status) {
      await recordImportAudit(this.auditService, this.logger, {
        projectId: transition.projectId,
        batchId,
        // The worker acts for the user who started the import.
        actorUserId: transition.createdBy,
        action: finishedAction,
        data: { totalItems: total, completedItems: completed, failedItems: failed },
      });
    }
  }

  /** Imports one file. Returns false when it was not claimed: another job took it, or the batch was cancelled or paused. */
  private async importItem(
    batch: ImportBatchEntity,
    item: AssetImportEntity,
    token: DriveAccessToken,
    userId: string,
  ): Promise<boolean> {
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
      .andWhere(
        "NOT EXISTS (SELECT 1 FROM import_batches b WHERE b.id = batch_id AND b.status IN ('cancelled', 'paused'))",
      )
      .execute();
    if (!claimed.affected) {
      return false;
    }
    const heartbeat = this.startHeartbeat('asset_imports', item.id);
    try {
      await this.downloadItem(batch, item, token, userId);
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  private async downloadItem(
    batch: ImportBatchEntity,
    item: AssetImportEntity,
    token: DriveAccessToken,
    userId: string,
  ) {
    const file = await this.getFile(token, item.sourceFileId ?? '');
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
    const assetId = uuidv7();
    const originalFilename = this.withExtension(
      file.name,
      file.mimeType,
      file.fileExtension ?? file.fullFileExtension,
    );
    const storageKey = `projects/${batch.projectId}/originals/${assetId}/${this.safeName(originalFilename)}`;
    // No limit on the total time, so large videos can finish; only a slow start or a stall aborts.
    const controller = new AbortController();
    const responseTimer = setTimeout(
      () => controller.abort(new Error('Google Drive download did not start responding in time')),
      DOWNLOAD_RESPONSE_TIMEOUT_MS,
    );
    let body: Readable | undefined;
    let uploadedBytes: number;
    try {
      const response = await driveFetch(
        token,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
        { signal: controller.signal },
      );
      clearTimeout(responseTimer);
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
      body = withIdleTimeout(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        DOWNLOAD_IDLE_TIMEOUT_MS,
        () => controller.abort(),
      );
      ({ sizeBytes: uploadedBytes } = await this.storage.putObject(
        storageKey,
        body,
        file.mimeType,
        contentLength,
      ));
    } finally {
      clearTimeout(responseTimer);
      body?.destroy();
      controller.abort();
    }
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
        fileSizeBytes: String(uploadedBytes),
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

  private async getFile(token: DriveAccessToken, fileId: string): Promise<DriveFile> {
    const response = await driveFetch(
      token,
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,fileExtension,fullFileExtension,modifiedTime,headRevisionId,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),owners(displayName,emailAddress)&supportsAllDrives=true`,
      { signal: AbortSignal.timeout(30_000) },
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
    token: DriveAccessToken,
  ): Promise<void> {
    const discovered = new Map<string, DriveFile>();
    const pending = [root.id];
    const maxFiles = 10_000;

    while (pending.length > 0) {
      const parentId = pending.shift();
      if (!parentId) {
        continue;
      }
      const files = await this.listChildren(token, parentId, batch.sourceDriveId);
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
    token: DriveAccessToken,
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
      const response = await driveFetch(
        token,
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        { signal: AbortSignal.timeout(30_000) },
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
