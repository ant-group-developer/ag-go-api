import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import type { DocumentQueueJobData } from '../../infra/queue/document-queue.service';
import { DOCUMENT_JOB, DOCUMENT_QUEUE } from '../../infra/queue/queue.constants';
import { DocumentsService } from './documents.service';

/**
 * Worker-io role `documents`: renders issued contracts, amendments and acceptance records (spec 10,
 * 13). The job carries only the document id; the personal data is decrypted here, in the worker,
 * and never leaves the backend.
 */
@Injectable()
export class DocumentWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(DocumentWorkerService.name);
  private connection?: Redis;
  private worker?: Worker<DocumentQueueJobData>;

  constructor(
    private readonly config: ConfigService,
    private readonly documents: DocumentsService,
  ) {}

  start(): void {
    if (this.worker) {
      return;
    }
    this.connection = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: null,
    });
    this.worker = new Worker<DocumentQueueJobData>(
      DOCUMENT_QUEUE,
      async (job) => {
        if (job.name !== DOCUMENT_JOB) {
          throw new Error(`Unsupported document job ${job.name}`);
        }
        await this.documents.generate(job.data.documentId);
      },
      {
        connection: this.connection,
        prefix: this.config.getOrThrow<string>('QUEUE_PREFIX'),
        concurrency: 2,
      },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Document job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit();
  }
}
