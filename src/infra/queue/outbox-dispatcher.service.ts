import { forwardRef, Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { AnalysisOutboxService } from '../../modules/analysis/analysis-outbox.service';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../modules/assets/storage/storage-adapter';
import { ASSET_STORAGE_PURGE_EVENT } from '../../modules/projects/project-asset-cleanup';
import { MediaQueueService } from './media-queue.service';

export const ASSET_ANALYSIS_REQUESTED_EVENT = 'asset.analysis.requested';

/** Retries wait 5 s, 10 s, 20 s, ... up to an hour; 30 attempts span about a day. */
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 30;
/**
 * A claimed event stays hidden from the next polls, of this or another worker host, for this
 * long while it is published (a project purge can take minutes). If the dispatcher dies
 * meanwhile, the event is picked up again once the lease runs out.
 */
const CLAIM_LEASE_SQL = "NOW() + interval '5 minutes'";
/** Events claimed per poll. */
const CLAIM_BATCH = 20;
/** Publishes running at once per process; a mass project deletion must not fan out unbounded. */
const MAX_IN_FLIGHT = 50;

@Injectable()
export class OutboxDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcherService.name);
  private timer?: NodeJS.Timeout;
  /** The claim in progress; a tick that finds one skips instead of piling up. */
  private claiming?: Promise<void>;
  /** Publishes started by earlier ticks and still running (a project purge can take minutes). */
  private readonly inFlight = new Set<Promise<boolean>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly mediaQueue: MediaQueueService,
    private readonly config: ConfigService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Optional()
    @Inject(forwardRef(() => AnalysisOutboxService))
    private readonly analysisOutbox?: AnalysisOutboxService,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const interval = this.config.getOrThrow<number>('OUTBOX_POLL_INTERVAL_MS');
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    void this.tick();
  }

  /**
   * Claims due events, one claim at a time per process, and publishes them in the background:
   * a long project purge keeps running while the next ticks claim and publish new render
   * requests. A failed claim (e.g. the database is unreachable) is logged and retried on the
   * next tick; left unhandled it would crash the worker process and every import and download
   * running in it.
   */
  private async tick(): Promise<void> {
    const room = MAX_IN_FLIGHT - this.inFlight.size;
    if (this.claiming || room <= 0) {
      return;
    }
    this.claiming = this.claimAndPublish(Math.min(CLAIM_BATCH, room));
    try {
      await this.claiming;
    } finally {
      this.claiming = undefined;
    }
  }

  private async claimAndPublish(limit: number): Promise<void> {
    try {
      for (const event of await this.claimDue(limit)) {
        const publishing: Promise<boolean> = this.publish(event)
          .catch((error: unknown) => {
            this.logger.error(
              `Outbox event ${event.id} publish failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
          })
          .finally(() => this.inFlight.delete(publishing));
        this.inFlight.add(publishing);
      }
    } catch (error) {
      this.logger.error(
        `Outbox poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Claims the due events and publishes them; resolves with how many were published. */
  async dispatchPending(): Promise<number> {
    const events = await this.claimDue(CLAIM_BATCH);
    // Side by side, so a long project purge does not hold back the render requests with it.
    const results = await Promise.allSettled(events.map((event) => this.publish(event)));
    return results.filter((result) => result.status === 'fulfilled' && result.value).length;
  }

  /** Locks up to `limit` due events, leases them and returns them for publishing. */
  private claimDue(limit: number): Promise<OutboxEventEntity[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager
        .createQueryBuilder(OutboxEventEntity, 'event')
        .where('event.status IN (:...statuses)', { statuses: ['pending', 'failed'] })
        .andWhere('event.availableAt <= NOW()')
        // Oldest due first: an event waiting out a retry delay never holds back newer ones.
        .orderBy('event.availableAt', 'ASC')
        .addOrderBy('event.createdAt', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(limit)
        .getMany();

      // The row locks end with this transaction, but the events stay pending until published;
      // the lease keeps other polls from publishing them a second time meanwhile.
      for (const event of rows) {
        await manager.update(OutboxEventEntity, event.id, {
          attemptCount: event.attemptCount + 1,
          lastError: null,
          availableAt: () => CLAIM_LEASE_SQL,
        });
      }
      return rows;
    });
  }

  /** Publishes one claimed event; true when published, false when it failed (and is retried). */
  private async publish(event: OutboxEventEntity): Promise<boolean> {
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
      } else if (event.eventType === ASSET_STORAGE_PURGE_EVENT) {
        await this.purgeAssetStorage(event);
      } else if (event.eventType === ASSET_ANALYSIS_REQUESTED_EVENT) {
        const analysisId = this.readString(event.payload.analysisId);
        if (!analysisId) {
          throw new Error('Outbox event asset.analysis.requested is missing analysisId');
        }
        if (!this.analysisOutbox) {
          throw new Error('AnalysisOutboxService not available — AnalysisModule not loaded');
        }
        await this.analysisOutbox.handleAnalysisRequested(analysisId);
      } else {
        this.logger.warn(
          `Outbox event ${event.id} has unknown type "${event.eventType}" — marking published`,
        );
      }
      await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
        status: 'published',
        publishedAt: new Date(),
        lastError: null,
      });
      return true;
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
        return false;
      }
      const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1), RETRY_MAX_DELAY_MS);
      this.logger.error(
        `Outbox event ${event.id} (${event.eventType}) failed, attempt ${attempts}/${MAX_ATTEMPTS}, retrying in ${Math.round(delay / 1000)} s: ${message}`,
      );
      // On the database clock, like the lease and the `available_at <= NOW()` poll.
      await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
        status: 'failed',
        availableAt: () => `NOW() + interval '${delay} milliseconds'`,
        lastError: message,
      });
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    // Lets the claim and the publishes in flight finish, instead of leaving events leased.
    await this.claiming;
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Removes the R2 objects of deleted assets stored outside a purged project prefix. Each prefix
   * is one asset's original or variants folder; broader ones are refused so a bad payload cannot
   * empty a whole project. Deleting is idempotent, so a retry after a partial run is safe.
   */
  private async purgeAssetStorage(event: OutboxEventEntity): Promise<void> {
    const prefixes = Array.isArray(event.payload.prefixes)
      ? event.payload.prefixes.filter((value): value is string => typeof value === 'string')
      : [];
    const invalid = prefixes.find((prefix) => !/^(projects|assets)\/[^/]+\/[^/]+\/./.test(prefix));
    if (invalid !== undefined) {
      throw new Error(`Outbox event has an invalid asset storage prefix: ${invalid}`);
    }
    let deleted = 0;
    for (const prefix of prefixes) {
      deleted += await this.storage.deletePrefix(prefix);
    }
    this.logger.log(`Deleted ${deleted} R2 object(s) of deleted assets`);
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
