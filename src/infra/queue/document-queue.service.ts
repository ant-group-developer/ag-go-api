import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DOCUMENT_JOB, DOCUMENT_QUEUE } from './queue.constants';

/** Only the document id: the worker reads the snapshots from the database (no PII in Redis). */
export type DocumentQueueJobData = {
  documentId: string;
};

/** Queue `documents` of worker-io: renders contract / amendment / acceptance files (spec 10, 13). */
@Injectable()
export class DocumentQueueService implements OnModuleDestroy {
  private connection?: Redis;
  private queue?: Queue<DocumentQueueJobData>;

  constructor(private readonly config: ConfigService) {}

  /** `attempt` makes a retry a new job (BullMQ ignores a job id it still keeps). */
  async addJob(data: DocumentQueueJobData, attempt = 0): Promise<void> {
    await this.getQueue().add(DOCUMENT_JOB, data, {
      jobId: attempt > 0 ? `${data.documentId}-${attempt}` : data.documentId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    await this.connection?.quit();
  }

  private getQueue(): Queue<DocumentQueueJobData> {
    if (!this.queue || !this.connection) {
      this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: null,
      });
      this.queue = new Queue<DocumentQueueJobData>(DOCUMENT_QUEUE, {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
      });
    }
    return this.queue;
  }
}
