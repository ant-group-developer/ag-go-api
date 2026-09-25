import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import { In, Repository } from 'typeorm';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { DownloadJobItemEntity } from '../../database/entities/download-job-item.entity';
import { DownloadJobEntity } from '../../database/entities/download-job.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import type { DownloadQueueJobData } from '../../infra/queue/download-queue.service';
import { DOWNLOAD_JOB, DOWNLOAD_QUEUE } from '../../infra/queue/queue.constants';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { findRenderedVariant, renderedFilename } from './rendered-variant';
import { createZipStream, type ZipStreamEntry } from './zip-stream';

type ZipSource = { itemId: string; key: string; name: string };

@Injectable()
export class DownloadWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(DownloadWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<DownloadQueueJobData>;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(DownloadJobEntity)
    private readonly jobRepository: Repository<DownloadJobEntity>,
    @InjectRepository(DownloadJobItemEntity)
    private readonly itemRepository: Repository<DownloadJobItemEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepository: Repository<AssetVariantEntity>,
    @InjectRepository(RenderProfileEntity)
    private readonly profileRepository: Repository<RenderProfileEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  start(): void {
    if (this.worker) {
      return;
    }
    this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<DownloadQueueJobData>(
      DOWNLOAD_QUEUE,
      async (job) => {
        if (job.name !== DOWNLOAD_JOB) {
          throw new Error(`Unsupported download job ${job.name}`);
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
      this.logger.error(`Download job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async process(job: Job<DownloadQueueJobData>): Promise<void> {
    const download = await this.jobRepository.findOne({
      where: { id: job.data.jobId, externalUserId: job.data.userId },
    });
    if (!download || ['cancelled', 'completed', 'expired'].includes(download.status)) {
      return;
    }
    // Every attempt rebuilds the whole archive, so a retry re-adds items an earlier attempt
    // already marked `added` and restarts the progress count.
    await this.jobRepository.update(download.id, { status: 'processing', completedItems: 0 });
    try {
      const items = await this.itemRepository.find({
        where: { downloadJobId: download.id, status: In(['queued', 'added']) },
        order: { createdAt: 'ASC' },
      });
      // Resolve every source first so a missing asset or unready variant fails the job
      // before anything is uploaded.
      const sources: ZipSource[] = [];
      for (const item of items) {
        const asset = await this.assetRepository.findOne({ where: { id: item.assetId } });
        if (!asset) {
          throw new Error(`Asset ${item.assetId} not found`);
        }
        let key = asset.originalStorageKey;
        let filename = asset.originalFilename;
        if (download.downloadType === 'rendered') {
          const variant = await findRenderedVariant(
            this.variantRepository,
            this.profileRepository,
            asset.id,
          );
          if (!variant) {
            throw new Error(`Rendered variant of ${asset.originalFilename} is not ready`);
          }
          key = variant.storageKey;
          filename = renderedFilename(asset.originalFilename, variant.mimeType);
        }
        sources.push({ itemId: item.id, key, name: `${item.projectMediaId}-${filename}` });
      }
      const storageKey = download.projectId
        ? `projects/${download.projectId}/downloads/${download.externalUserId}/${download.id}.zip`
        : `downloads/${download.externalUserId}/${download.id}.zip`;
      // The archive streams straight into a multipart upload, one source object at a time,
      // so memory stays bounded by the upload's part buffers whatever the archive size.
      const head = await this.storage.putObject(
        storageKey,
        createZipStream(this.zipEntries(download.id, sources)),
        'application/zip',
      );
      await this.jobRepository.update(download.id, {
        status: 'completed',
        zipBucket: this.config.getOrThrow<string>('R2_BUCKET'),
        zipStorageKey: storageKey,
        zipSizeBytes: String(head.sizeBytes),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Download worker failed';
      await this.jobRepository.update(download.id, {
        status: 'failed',
        errorMessage: message.slice(0, 4000),
      });
      throw error;
    }
  }

  /** Yields each source to the ZIP writer; an item counts as added once its body is written. */
  private async *zipEntries(
    downloadId: string,
    sources: ZipSource[],
  ): AsyncGenerator<ZipStreamEntry> {
    for (const source of sources) {
      yield { name: source.name, body: this.storage.readObject(source.key) };
      // Resumes only after the writer has consumed the whole body and asks for the next entry.
      await this.itemRepository.update(source.itemId, { status: 'added' });
      await this.jobRepository.increment({ id: downloadId }, 'completedItems', 1);
    }
  }
}
