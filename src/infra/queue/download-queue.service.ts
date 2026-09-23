import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DOWNLOAD_JOB, DOWNLOAD_QUEUE } from './queue.constants';

export type DownloadQueueJobData = {
  jobId: string;
  userId: string;
};

@Injectable()
export class DownloadQueueService implements OnModuleDestroy {
  private connection?: Redis;
  private queue?: Queue<DownloadQueueJobData>;

  async addJob(data: DownloadQueueJobData): Promise<void> {
    await this.getQueue().add(DOWNLOAD_JOB, data, {
      jobId: data.jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  }

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    await this.connection?.quit();
  }

  private getQueue(): Queue<DownloadQueueJobData> {
    if (!this.queue || !this.connection) {
      this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: null,
      });
      this.queue = new Queue<DownloadQueueJobData>(DOWNLOAD_QUEUE, {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
      });
    }
    return this.queue;
  }
}
