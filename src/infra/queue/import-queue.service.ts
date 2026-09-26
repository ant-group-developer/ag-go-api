import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import {
  IMPORT_DISCOVERY_JOB,
  IMPORT_DISCOVERY_QUEUE,
  IMPORT_JOB,
  IMPORT_QUEUE,
} from './queue.constants';

export type ImportQueueJobData = {
  batchId: string;
  userId: string;
};

@Injectable()
export class ImportQueueService implements OnModuleDestroy {
  private connection?: Redis;
  private queue?: Queue<ImportQueueJobData>;
  private discoveryQueue?: Queue<ImportQueueJobData>;

  constructor(private readonly config: ConfigService) {}

  async addJob(data: ImportQueueJobData): Promise<string> {
    const jobId = `${data.batchId}-${uuidv7()}`;
    await this.getQueues().queue.add(IMPORT_JOB, data, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
    return jobId;
  }

  /**
   * Lists the files of the batch's folders right away, so a batch waiting behind other imports
   * already shows its file count and size. The import job does the same when it starts, so a
   * discovery job that fails or never runs only delays those numbers. One pending job per batch.
   */
  async addDiscoveryJob(data: ImportQueueJobData): Promise<void> {
    await this.getQueues().discoveryQueue.add(IMPORT_DISCOVERY_JOB, data, {
      jobId: `${data.batchId}-discovery`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /** True while the job is still waiting, delayed or running; false once it is gone, completed or failed. */
  async hasPendingJob(jobId: string): Promise<boolean> {
    const job = await this.getQueues().queue.getJob(jobId);
    if (!job) {
      return false;
    }
    const state = await job.getState();
    return ['waiting', 'waiting-children', 'delayed', 'prioritized', 'active'].includes(state);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    await this.discoveryQueue?.close();
    await this.connection?.quit();
  }

  private getQueues(): {
    queue: Queue<ImportQueueJobData>;
    discoveryQueue: Queue<ImportQueueJobData>;
  } {
    if (!this.queue || !this.discoveryQueue || !this.connection) {
      this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: null,
      });
      const prefix = this.config.getOrThrow<string>('QUEUE_PREFIX');
      this.queue = new Queue<ImportQueueJobData>(IMPORT_QUEUE, {
        connection: this.connection,
        prefix,
      });
      this.discoveryQueue = new Queue<ImportQueueJobData>(IMPORT_DISCOVERY_QUEUE, {
        connection: this.connection,
        prefix,
      });
    }
    return { queue: this.queue, discoveryQueue: this.discoveryQueue };
  }
}
