import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export type RetentionResult = {
  outboxDeleted: number;
  systemLogsDeleted: number;
  studioUsageDeleted: number;
};

/** Default retention periods in days. */
export const DEFAULT_RETENTION_OUTBOX_PUBLISHED_DAYS = 7;
export const DEFAULT_RETENTION_OUTBOX_DEAD_DAYS = 30;
export const DEFAULT_RETENTION_LOG_ACT_AS_DAYS = 30;
export const DEFAULT_RETENTION_LOG_ANALYSIS_DAYS = 30;
export const DEFAULT_RETENTION_LOG_SYSTEM_DAYS = 90;
export const DEFAULT_RETENTION_STUDIO_USAGE_REMOVED_DAYS = 30;
export const DEFAULT_RETENTION_STUDIO_USAGE_DAYS = 180;
/** Runs once per day (24 hours). */
export const DEFAULT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Delay before the first retention run after worker boot, giving priority to normal startup. */
export const RETENTION_INITIAL_DELAY_MS = 30_000;
/** Batch limit per delete query to avoid table locks. */
export const RETENTION_BATCH_SIZE = 5_000;

@Injectable()
export class DataRetentionService implements OnModuleDestroy {
  private readonly logger = new Logger(DataRetentionService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<RetentionResult>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    const intervalMs =
      this.config.get<number>('RETENTION_INTERVAL_MS') ?? DEFAULT_RETENTION_INTERVAL_MS;

    // First run after a short delay so boot-up traffic settles
    const initialTimer = setTimeout(() => {
      void this.runRetention();
      this.timer = setInterval(() => void this.runRetention(), intervalMs);
      this.timer.unref();
    }, RETENTION_INITIAL_DELAY_MS);
    initialTimer.unref();
    this.timer = initialTimer;
  }

  async runRetention(): Promise<RetentionResult> {
    if (this.running) {
      return this.running;
    }
    this.running = this.executeRetention();
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async executeRetention(): Promise<RetentionResult> {
    this.logger.log('Starting daily data retention cleanup...');
    const result: RetentionResult = {
      outboxDeleted: 0,
      systemLogsDeleted: 0,
      studioUsageDeleted: 0,
    };

    try {
      result.outboxDeleted = await this.purgeOutboxEvents();
    } catch (error) {
      this.logger.error(
        `Failed to purge outbox events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      result.systemLogsDeleted = await this.purgeSystemLogs();
    } catch (error) {
      this.logger.error(
        `Failed to purge system logs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      result.studioUsageDeleted = await this.purgeStudioUsageEvents();
    } catch (error) {
      this.logger.error(
        `Failed to purge studio usage events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.logger.log(
      `Data retention completed: removed ${result.outboxDeleted} outbox event(s), ` +
        `${result.systemLogsDeleted} system log(s), ${result.studioUsageDeleted} studio usage event(s)`,
    );
    return result;
  }

  /**
   * Purges published outbox events older than RETENTION_OUTBOX_PUBLISHED_DAYS (default 7)
   * and dead events older than RETENTION_OUTBOX_DEAD_DAYS (default 30).
   * Pending and retrying failed events are never deleted.
   */
  private async purgeOutboxEvents(): Promise<number> {
    const publishedDays =
      this.config.get<number>('RETENTION_OUTBOX_PUBLISHED_DAYS') ??
      DEFAULT_RETENTION_OUTBOX_PUBLISHED_DAYS;
    const deadDays =
      this.config.get<number>('RETENTION_OUTBOX_DEAD_DAYS') ?? DEFAULT_RETENTION_OUTBOX_DEAD_DAYS;

    const publishedCutoff = new Date(Date.now() - publishedDays * 86_400_000);
    const deadCutoff = new Date(Date.now() - deadDays * 86_400_000);

    let total = 0;
    while (true) {
      const rows = await this.dataSource.query(
        `DELETE FROM outbox_events
         WHERE id IN (
           SELECT id FROM outbox_events
           WHERE (status = 'published' AND (published_at < $1 OR (published_at IS NULL AND created_at < $1)))
              OR (status = 'dead' AND updated_at < $2)
           LIMIT ${RETENTION_BATCH_SIZE}
         )
         RETURNING id`,
        [publishedCutoff, deadCutoff],
      );
      const count = Array.isArray(rows) ? rows.length : 0;
      total += count;
      if (count < RETENTION_BATCH_SIZE) {
        break;
      }
    }
    return total;
  }

  /**
   * Purges act_as audit logs and analysis pipeline logs older than 30 days,
   * plus other generic system logs older than 90 days.
   */
  private async purgeSystemLogs(): Promise<number> {
    const actAsDays =
      this.config.get<number>('RETENTION_LOG_ACT_AS_DAYS') ?? DEFAULT_RETENTION_LOG_ACT_AS_DAYS;
    const analysisDays =
      this.config.get<number>('RETENTION_LOG_ANALYSIS_DAYS') ?? DEFAULT_RETENTION_LOG_ANALYSIS_DAYS;
    const systemLogDays =
      this.config.get<number>('RETENTION_LOG_SYSTEM_DAYS') ?? DEFAULT_RETENTION_LOG_SYSTEM_DAYS;

    const actAsCutoff = new Date(Date.now() - actAsDays * 86_400_000);
    const analysisCutoff = new Date(Date.now() - analysisDays * 86_400_000);
    const systemLogCutoff = new Date(Date.now() - systemLogDays * 86_400_000);

    let total = 0;
    while (true) {
      const rows = await this.dataSource.query(
        `DELETE FROM system_logs
         WHERE id IN (
           SELECT id FROM system_logs
           WHERE (category = 'service_key' AND action = 'act_as' AND created_at < $1)
              OR (category = 'analysis' AND created_at < $2)
              OR (created_at < $3)
           LIMIT ${RETENTION_BATCH_SIZE}
         )
         RETURNING id`,
        [actAsCutoff, analysisCutoff, systemLogCutoff],
      );
      const count = Array.isArray(rows) ? rows.length : 0;
      total += count;
      if (count < RETENTION_BATCH_SIZE) {
        break;
      }
    }
    return total;
  }

  /**
   * Purges source_removed events older than 30 days and all other usage events older than 180 days.
   */
  private async purgeStudioUsageEvents(): Promise<number> {
    const removedDays =
      this.config.get<number>('RETENTION_STUDIO_USAGE_REMOVED_DAYS') ??
      DEFAULT_RETENTION_STUDIO_USAGE_REMOVED_DAYS;
    const usageDays =
      this.config.get<number>('RETENTION_STUDIO_USAGE_DAYS') ?? DEFAULT_RETENTION_STUDIO_USAGE_DAYS;

    const removedCutoff = new Date(Date.now() - removedDays * 86_400_000);
    const usageCutoff = new Date(Date.now() - usageDays * 86_400_000);

    let total = 0;
    while (true) {
      const rows = await this.dataSource.query(
        `DELETE FROM studio_usage_events
         WHERE id IN (
           SELECT id FROM studio_usage_events
           WHERE (kind = 'source_removed' AND occurred_at < $1)
              OR (occurred_at < $2)
           LIMIT ${RETENTION_BATCH_SIZE}
         )
         RETURNING id`,
        [removedCutoff, usageCutoff],
      );
      const count = Array.isArray(rows) ? rows.length : 0;
      total += count;
      if (count < RETENTION_BATCH_SIZE) {
        break;
      }
    }
    return total;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }
}
