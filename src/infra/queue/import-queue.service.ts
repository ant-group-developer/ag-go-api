import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { IMPORT_JOB, IMPORT_QUEUE } from './queue.constants';

export type ImportQueueJobData = {
  batchId: string;
  userId: string;
};

@Injectable()
export class ImportQueueService implements OnModuleDestroy {
  private connection?: Redis;
  private queue?: Queue<ImportQueueJobData>;

  constructor(private readonly config: ConfigService) {}

  async addJob(data: ImportQueueJobData): Promise<string> {
    const jobId = `${data.batchId}-${uuidv7()}`;
    await this.getQueue().add(IMPORT_JOB, data, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
    return jobId;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    await this.connection?.quit();
  }

  private getQueue(): Queue<ImportQueueJobData> {
    if (!this.queue || !this.connection) {
      this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: null,
      });
      this.queue = new Queue<ImportQueueJobData>(IMPORT_QUEUE, {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
      });
    }
    return this.queue;
  }
}
