import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage/storage-adapter';

@Injectable()
export class MediaProcessingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaProcessingService.name);
  private workerTimer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepository: Repository<AssetVariantEntity>,
    @InjectRepository(MediaRenderJobEntity)
    private readonly jobRepository: Repository<MediaRenderJobEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  onModuleInit(): void {
    if (process.env.MEDIA_WORKER_ENABLED === 'false') {
      return;
    }
    this.workerTimer = setInterval(() => {
      void this.processPending();
    }, 1000);
    this.workerTimer.unref();
    void this.processPending();
  }

  onModuleDestroy(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
    }
  }

  async enqueue(assetId: string, userId: string) {
    const dedupeKey = `${assetId}:system:1`;
    const active = await this.jobRepository
      .createQueryBuilder('job')
      .where('job.dedupe_key = :dedupeKey', { dedupeKey })
      .andWhere('job.status IN (:...statuses)', { statuses: ['queued', 'processing'] })
      .getOne();
    if (active) {
      return active;
    }

    const previous = await this.jobRepository.findOne({
      where: { assetId },
      order: { createdAt: 'DESC' },
    });
    const job = await this.jobRepository.save(
      this.jobRepository.create({
        id: uuidv7(),
        assetId,
        renderProfileId: null,
        renderVersion: 1,
        queueJobId: null,
        dedupeKey,
        status: 'queued',
        progressPercent: 0,
        progressMessage: 'Queued for local processing',
        attemptCount: (previous?.attemptCount ?? 0) + 1,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdBy: userId,
      }),
    );
    void this.processPending();
    return job;
  }

  async processPending(): Promise<void> {
    const jobs = await this.jobRepository.find({
      where: { status: 'queued' },
      order: { createdAt: 'ASC' },
      take: 2,
    });
    for (const job of jobs) {
      await this.processJob(job);
    }
  }

  private async processJob(job: MediaRenderJobEntity): Promise<void> {
    const claimed = await this.jobRepository.update(
      { id: job.id, status: 'queued' },
      {
        status: 'processing',
        progressPercent: 10,
        progressMessage: 'Reading original object',
        startedAt: new Date(),
      },
    );
    if (!claimed.affected) {
      return;
    }

    try {
      const asset = await this.assetRepository.findOne({ where: { id: job.assetId } });
      if (!asset) {
        throw new Error('Asset not found');
      }
      const original = await this.storage.headObject(asset.originalStorageKey);
      if (!original) {
        throw new Error('Original object not found');
      }

      await this.assetRepository.update(asset.id, { processingStatus: 'processing' });
      await this.jobRepository.update(job.id, {
        progressPercent: 40,
        progressMessage: 'Creating local preview variants',
      });

      const variantCodes = ['thumbnail', 'preview'];
      for (const variantCode of variantCodes) {
        const storageKey = `variants/${asset.id}/${variantCode}-${asset.originalFilename}`;
        const output = await this.storage.copyObject(asset.originalStorageKey, storageKey);
        const existing = await this.variantRepository.findOne({
          where: { assetId: asset.id, variantCode },
        });
        await this.variantRepository.save(
          this.variantRepository.create({
            id: existing?.id ?? uuidv7(),
            assetId: asset.id,
            renderProfileId: null,
            variantCode,
            renderVersion: 1,
            storageProvider: asset.storageProvider,
            bucketName: asset.originalBucket,
            storageKey,
            mimeType: asset.mimeType,
            fileSizeBytes: String(output.sizeBytes),
            width: null,
            height: null,
            hasWatermark: false,
            status: 'ready',
            processingError: null,
          }),
        );
      }

      await this.assetRepository.update(asset.id, { processingStatus: 'ready' });
      await this.jobRepository.update(job.id, {
        status: 'completed',
        progressPercent: 100,
        progressMessage: 'Local variants are ready',
        finishedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Media processing failed';
      this.logger.error(`Asset ${job.assetId} processing failed: ${message}`);
      await this.assetRepository.update(job.assetId, { processingStatus: 'failed' });
      await this.jobRepository.update(job.id, {
        status: 'failed',
        progressMessage: 'Media processing failed',
        errorCode: 'PROCESSING_FAILED',
        errorMessage: message,
        finishedAt: new Date(),
      });
    }
  }
}
