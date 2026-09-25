import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import sharp from 'sharp';
import { v7 as uuidv7 } from 'uuid';
import {
  MediaQueueService,
  type MediaProcessingJobData,
} from '../../infra/queue/media-queue.service';
import { MEDIA_PROCESSING_JOB, MEDIA_PROCESSING_QUEUE } from '../../infra/queue/queue.constants';
import { MediaProcessingService } from './media-processing.service';

/** How often the worker looks for render jobs whose worker died mid-run. */
const STALE_JOB_SWEEP_MS = 60_000;

@Injectable()
export class MediaQueueWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(MediaQueueWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<MediaProcessingJobData>;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly processingService: MediaProcessingService,
    private readonly mediaQueue: MediaQueueService,
  ) {}

  start(): void {
    if (this.worker) {
      return;
    }
    // libvips sizes its pool from the host's cores too; match the FFmpeg cap.
    sharp.concurrency(this.config.getOrThrow<number>('MEDIA_FFMPEG_THREADS'));
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

    this.sweepTimer = setInterval(() => void this.recoverStaleJobs(), STALE_JOB_SWEEP_MS);
    this.sweepTimer.unref();
    void this.recoverStaleJobs();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    await this.worker?.close();
    await this.connection?.quit();
  }

  private async recoverStaleJobs(): Promise<void> {
    try {
      const requeued = await this.processingService.recoverStaleJobs();
      for (const job of requeued) {
        try {
          // A fresh BullMQ id: the original job may still be kept as completed or failed.
          await this.mediaQueue.addProcessingJob({
            eventId: `${job.id}-recover-${uuidv7()}`,
            assetId: job.assetId,
            renderJobId: job.id,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Render job ${job.id} could not be re-queued: ${message}`);
          await this.processingService.failUnqueuedJob(job.id, message);
        }
      }
    } catch (error) {
      this.logger.error(
        `Stale render job sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
