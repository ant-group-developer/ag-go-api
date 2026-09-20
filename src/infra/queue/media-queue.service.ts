import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { MEDIA_PROCESSING_JOB, MEDIA_PROCESSING_QUEUE } from './queue.constants';

export type MediaProcessingJobData = {
  eventId: string;
  assetId: string;
  renderJobId: string;
  userId?: string;
};

@Injectable()
export class MediaQueueService implements OnModuleDestroy {
  private connection?: Redis;
  private queue?: Queue<MediaProcessingJobData>;

  constructor(private readonly config: ConfigService) {}

  async addProcessingJob(data: MediaProcessingJobData): Promise<void> {
    await this.getQueue().add(MEDIA_PROCESSING_JOB, data, {
      jobId: data.eventId,
      attempts: this.config.getOrThrow<number>('MEDIA_JOB_ATTEMPTS'),
      backoff: {
        type: 'exponential',
        delay: this.config.getOrThrow<number>('MEDIA_JOB_BACKOFF_MS'),
      },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    await this.connection?.quit();
  }

  private getQueue(): Queue<MediaProcessingJobData> {
    if (!this.queue || !this.connection) {
      this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: null,
      });
      this.queue = new Queue<MediaProcessingJobData>(MEDIA_PROCESSING_QUEUE, {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
      });
    }
    return this.queue;
  }
}
