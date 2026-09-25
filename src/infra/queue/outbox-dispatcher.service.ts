import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../modules/assets/storage/storage-adapter';
import { MediaQueueService } from './media-queue.service';

/** Retries wait 5 s, 10 s, 20 s, ... up to an hour; 30 attempts span about a day. */
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 30;

@Injectable()
export class OutboxDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mediaQueue: MediaQueueService,
    private readonly config: ConfigService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const interval = this.config.getOrThrow<number>('OUTBOX_POLL_INTERVAL_MS');
    this.timer = setInterval(() => {
      void this.dispatchPending();
    }, interval);
    this.timer.unref();
    void this.dispatchPending();
  }

  async dispatchPending(): Promise<number> {
    const events = await this.dataSource.transaction(async (manager) => {
      const rows = await manager
        .createQueryBuilder(OutboxEventEntity, 'event')
        .where('event.status IN (:...statuses)', { statuses: ['pending', 'failed'] })
        .andWhere('event.availableAt <= NOW()')
        // Oldest due first: an event waiting out a retry delay never holds back newer ones.
        .orderBy('event.availableAt', 'ASC')
        .addOrderBy('event.createdAt', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(20)
        .getMany();

      for (const event of rows) {
        await manager.update(OutboxEventEntity, event.id, {
          attemptCount: event.attemptCount + 1,
          lastError: null,
        });
      }
      return rows;
    });

    let published = 0;
    for (const event of events) {
      try {
        if (event.eventType === 'asset.processing.requested') {
          const assetId = this.readString(event.payload.assetId);
          if (!assetId) {
            throw new Error('Outbox event is missing assetId');
          }
          await this.mediaQueue.addProcessingJob({
            eventId: event.id,
            assetId,
            renderJobId: this.readString(event.payload.renderJobId) ?? assetId,
            userId: this.readString(event.payload.userId),
          });
        } else if (event.eventType === 'project.storage.purge') {
          await this.purgeProjectStorage(event);
        }
        await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
          status: 'published',
          publishedAt: new Date(),
          lastError: null,
        });
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Outbox publish failed';
        // attemptCount was read before this attempt was counted.
        const attempts = event.attemptCount + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.logger.error(
            `Outbox event ${event.id} (${event.eventType}) gave up after ${attempts} attempts: ${message}`,
          );
          await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
            status: 'dead',
            lastError: message,
          });
          continue;
        }
        const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1), RETRY_MAX_DELAY_MS);
        this.logger.error(
          `Outbox event ${event.id} (${event.eventType}) failed, attempt ${attempts}/${MAX_ATTEMPTS}, retrying in ${Math.round(delay / 1000)} s: ${message}`,
        );
        await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
          status: 'failed',
          availableAt: new Date(Date.now() + delay),
          lastError: message,
        });
      }
    }
    return published;
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Removes a deleted project's R2 objects, keeping the ones other projects still use. */
  private async purgeProjectStorage(event: OutboxEventEntity): Promise<void> {
    const prefix = this.readString(event.payload.prefix);
    if (!prefix?.startsWith('projects/') || !prefix.endsWith('/')) {
      throw new Error('Outbox event has an invalid project storage prefix');
    }
    const keepPrefixes = Array.isArray(event.payload.keepPrefixes)
      ? event.payload.keepPrefixes.filter((value): value is string => typeof value === 'string')
      : [];
    const deleted = await this.storage.deletePrefix(prefix, (key) =>
      keepPrefixes.some((keepPrefix) => key.startsWith(keepPrefix)),
    );
    this.logger.log(`Deleted ${deleted} R2 object(s) under ${prefix}`);
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
