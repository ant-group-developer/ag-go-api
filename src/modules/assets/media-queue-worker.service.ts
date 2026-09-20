import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import type { MediaProcessingJobData } from '../../infra/queue/media-queue.service';
import { MEDIA_PROCESSING_JOB, MEDIA_PROCESSING_QUEUE } from '../../infra/queue/queue.constants';
import { MediaProcessingService } from './media-processing.service';

@Injectable()
export class MediaQueueWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(MediaQueueWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<MediaProcessingJobData>;

  constructor(
    private readonly config: ConfigService,
    private readonly processingService: MediaProcessingService,
  ) {}

  start(): void {
    if (this.worker) {
      return;
    }
    this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<MediaProcessingJobData>(
      MEDIA_PROCESSING_QUEUE,
      async (job) => {
        if (job.name !== MEDIA_PROCESSING_JOB) {
          throw new Error(`Unsupported media job ${job.name}`);
        }
        await this.processingService.processJobById(
          job.data.renderJobId,
          job.data.assetId,
          String(job.id),
        );
      },
      {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
        concurrency: this.config.getOrThrow<number>('MEDIA_WORKER_CONCURRENCY'),
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Media job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    this.worker.on('error', (error) => {
      this.logger.error(`Media worker error: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }
}
