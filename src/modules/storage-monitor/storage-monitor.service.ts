import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { CloudflareR2AnalyticsClient } from './cloudflare-r2-analytics.client';
import { R2InventoryClient } from './r2-inventory.client';
import { buildStorageAlerts } from './storage-alerts';
import { StorageAuditService } from './storage-audit.service';
import {
  EXPECTED_STORAGE_SQL,
  expectedBytesOf,
  toExpectedBreakdown,
  type ExpectedStorageRow,
} from './storage-expected.sql';
import type {
  ExpectedStorageBreakdown,
  StorageOverview,
  StorageSnapshotView,
} from './storage-monitor.types';

/** Snapshots are due every hour; the loop checks every minute so a manual audit starts soon. */
const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 30;
/** One history point per this many hours (30 days x 4 = 120 points on the chart). */
const HISTORY_STEP_HOURS = 6;

type SnapshotRow = {
  slot: Date;
  status: StorageSnapshotView['status'];
  bucket_payload_bytes: string | null;
  bucket_metadata_bytes: string | null;
  bucket_objects: string | null;
  bucket_pending_uploads: string | null;
  bucket_measured_at: Date | null;
  expected_bytes: string | null;
  leaked_bytes: string | null;
  expected_breakdown: ExpectedStorageBreakdown | null;
  operations: Record<string, number> | null;
  class_a_operations: string | null;
  class_b_operations: string | null;
  error: string | null;
};

/**
 * Hourly snapshots of the bucket against the database, and the weekly audit (StorageAuditService).
 * Runs only in the `outbox` worker role. Several hosts may run it: each hour's row is unique on
 * `slot`, so only the host that inserts it takes the snapshot.
 */
@Injectable()
export class StorageMonitorService implements OnModuleDestroy {
  private readonly logger = new Logger(StorageMonitorService.name);
  private timer?: NodeJS.Timeout;
  private snapshotting = false;
  private auditing = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly analytics: CloudflareR2AnalyticsClient,
    private readonly inventory: R2InventoryClient,
    private readonly audits: StorageAuditService,
  ) {}

  start(): void {
    if (this.timer) return;
    if (!this.analytics.isConfigured) {
      this.logger.warn(
        'CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ANALYTICS_TOKEN not set — storage snapshots record ' +
          'the database side only',
      );
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.audits.stop();
  }

  /** Snapshot and audit run apart: an audit takes long and must not hold up the hourly snapshot. */
  private tick(): void {
    if (!this.snapshotting) {
      this.snapshotting = true;
      void this.takeSnapshot(new Date())
        .catch((error: unknown) => this.logger.error(`Storage snapshot failed: ${message(error)}`))
        .finally(() => {
          this.snapshotting = false;
        });
    }
    if (!this.auditing) {
      this.auditing = true;
      void this.audits
        .scheduleIfDue()
        .then(() => this.audits.runNext())
        .catch((error: unknown) =>
          this.logger.error(`Storage audit loop failed: ${message(error)}`),
        )
        .finally(() => {
          this.auditing = false;
        });
    }
  }

  /** Takes the snapshot of the hour `now` falls in, unless a host already took it. */
  async takeSnapshot(now: Date): Promise<void> {
    const slot = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
    const inserted = (await this.dataSource.query(
      `INSERT INTO storage_snapshots (id, slot) VALUES ($1, $2)
       ON CONFLICT (slot) DO NOTHING RETURNING id`,
      [uuidv7(), slot],
    )) as Array<{ id: string }>;
    const id = inserted[0]?.id;
    if (!id) {
      return;
    }

    const expectedRows = (await this.dataSource.query(
      EXPECTED_STORAGE_SQL,
    )) as ExpectedStorageRow[];
    const breakdown = toExpectedBreakdown(expectedRows[0] ?? {});
    let error: string | null = null;
    let storage: Awaited<ReturnType<CloudflareR2AnalyticsClient['storage']>> = null;
    let operations: Awaited<ReturnType<CloudflareR2AnalyticsClient['operations']>> | null = null;
    if (this.analytics.isConfigured) {
      try {
        [storage, operations] = await Promise.all([
          this.analytics.storage(this.inventory.bucket, now),
          this.analytics.operations(this.inventory.bucket, new Date(slot.getTime() - DAY_MS), slot),
        ]);
      } catch (cause) {
        error = message(cause);
        this.logger.warn(`Cloudflare analytics unavailable: ${error}`);
      }
    }
    await this.dataSource.query(
      `UPDATE storage_snapshots
       SET status = $2, completed_at = now(), error = $3,
           bucket_payload_bytes = $4, bucket_metadata_bytes = $5, bucket_objects = $6,
           bucket_pending_uploads = $7, bucket_measured_at = $8,
           expected_bytes = $9, leaked_bytes = $10, expected_breakdown = $11::jsonb,
           operations = $12::jsonb, class_a_operations = $13, class_b_operations = $14
       WHERE id = $1`,
      [
        id,
        error ? 'failed' : 'completed',
        error,
        storage?.payloadBytes ?? null,
        storage?.metadataBytes ?? null,
        storage?.objects ?? null,
        storage?.pendingUploads ?? null,
        storage?.measuredAt ?? null,
        expectedBytesOf(breakdown),
        breakdown.removedMedia.bytes,
        JSON.stringify(breakdown),
        operations ? JSON.stringify(operations.byAction) : null,
        operations?.classA ?? null,
        operations?.classB ?? null,
      ],
    );
  }

  async overview(): Promise<StorageOverview> {
    const now = new Date();
    const [latestRows, attemptRows, historyRows, audits] = await Promise.all([
      this.dataSource.query(
        `SELECT * FROM storage_snapshots WHERE status = 'completed' ORDER BY slot DESC LIMIT 1`,
      ) as Promise<SnapshotRow[]>,
      this.dataSource.query(
        `SELECT * FROM storage_snapshots WHERE status <> 'running' ORDER BY slot DESC LIMIT 1`,
      ) as Promise<SnapshotRow[]>,
      this.dataSource.query(
        `SELECT * FROM storage_snapshots
         WHERE status = 'completed' AND slot > now() - make_interval(days => $1)
           AND EXTRACT(HOUR FROM slot AT TIME ZONE 'UTC')::int % $2 = 0
         ORDER BY slot`,
        [HISTORY_DAYS, HISTORY_STEP_HOURS],
      ) as Promise<SnapshotRow[]>,
      this.audits.latest(),
    ]);
    const latest = latestRows[0] ? toSnapshotView(latestRows[0]) : null;

    let dayBefore: StorageSnapshotView | null = null;
    let weeklyClassAAverage: number | null = null;
    if (latest) {
      const latestSlot = new Date(latest.slot);
      const [dayBeforeRows, weekRows] = (await Promise.all([
        this.dataSource.query(
          `SELECT * FROM storage_snapshots
           WHERE status = 'completed' AND slot <= $1 ORDER BY slot DESC LIMIT 1`,
          [new Date(latestSlot.getTime() - 23 * HOUR_MS)],
        ),
        this.dataSource.query(
          `SELECT AVG(class_a_operations)::float8 AS average FROM storage_snapshots
           WHERE status = 'completed' AND class_a_operations IS NOT NULL
             AND slot BETWEEN $1 AND $2`,
          [new Date(latestSlot.getTime() - 8 * DAY_MS), new Date(latestSlot.getTime() - DAY_MS)],
        ),
      ])) as [SnapshotRow[], Array<{ average: number | null }>];
      dayBefore = dayBeforeRows[0] ? toSnapshotView(dayBeforeRows[0]) : null;
      weeklyClassAAverage = weekRows[0]?.average ?? null;
    }
    const latestAttempt = attemptRows[0] ? toSnapshotView(attemptRows[0]) : null;
    const lastCompletedAudit = audits.latest?.status === 'completed' ? null : audits.completed;
    const history = historyRows.map(toSnapshotView);
    // The chart ends on the latest snapshot, which seldom falls on a step hour.
    if (latest && history[history.length - 1]?.slot !== latest.slot) {
      history.push(latest);
    }

    return {
      bucket: this.inventory.bucket,
      analyticsConfigured: this.analytics.isConfigured,
      checkedAt: now.toISOString(),
      latest,
      dayBefore,
      history,
      latestAudit: audits.latest,
      lastCompletedAudit,
      alerts: buildStorageAlerts({
        now,
        analyticsConfigured: this.analytics.isConfigured,
        latest,
        latestAttempt,
        dayBefore,
        weeklyClassAAverage,
        latestAudit: audits.latest,
        lastCompletedAudit: audits.completed,
      }),
    };
  }
}

function nullableNumber(value: string | null): number | null {
  return value == null ? null : Number(value);
}

export function toSnapshotView(row: SnapshotRow): StorageSnapshotView {
  const payload = nullableNumber(row.bucket_payload_bytes);
  const bucketBytes = payload == null ? null : payload + Number(row.bucket_metadata_bytes ?? 0);
  const expectedBytes = nullableNumber(row.expected_bytes);
  const leakedBytes = nullableNumber(row.leaked_bytes);
  return {
    slot: new Date(row.slot).toISOString(),
    status: row.status,
    bucketBytes,
    bucketObjects: nullableNumber(row.bucket_objects),
    bucketPendingUploads: nullableNumber(row.bucket_pending_uploads),
    bucketMeasuredAt: row.bucket_measured_at
      ? new Date(row.bucket_measured_at).toISOString()
      : null,
    expectedBytes,
    leakedBytes,
    unexplainedBytes:
      bucketBytes == null || expectedBytes == null
        ? null
        : bucketBytes - expectedBytes - (leakedBytes ?? 0),
    expectedBreakdown: row.expected_breakdown,
    operations: row.operations,
    classAOperations: nullableNumber(row.class_a_operations),
    classBOperations: nullableNumber(row.class_b_operations),
    error: row.error,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
