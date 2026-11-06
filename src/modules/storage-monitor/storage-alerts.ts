import type { StorageAlert, StorageAuditView, StorageSnapshotView } from './storage-monitor.types';

/** Snapshots are hourly; three missed hours mean the outbox worker is not taking them. */
export const SNAPSHOT_STALE_MS = 3 * 3_600_000;
/** Unexplained bytes growing by more than this in a day is worth a look (50 GB). */
export const UNEXPLAINED_GROWTH_ALERT_BYTES = 50e9;
/** Class A operations of the last 24h above this multiple of the weekly average... */
export const CLASS_A_SPIKE_FACTOR = 3;
/** ...and above this floor, so a quiet bucket does not alert on a few hundred requests. */
export const CLASS_A_SPIKE_MIN_OPERATIONS = 20_000;
/** `other` objects (no key the app writes) above this size in the last audit (1 GB). */
export const UNKNOWN_OBJECTS_ALERT_BYTES = 1e9;

export type StorageAlertInput = {
  now: Date;
  analyticsConfigured: boolean;
  /** Latest completed snapshot. */
  latest: StorageSnapshotView | null;
  /** Latest snapshot whatever its status. */
  latestAttempt: StorageSnapshotView | null;
  dayBefore: StorageSnapshotView | null;
  /** Average class A operations (24h windows) of the week before `latest`, null without data. */
  weeklyClassAAverage: number | null;
  latestAudit: StorageAuditView | null;
  lastCompletedAudit: StorageAuditView | null;
};

export function buildStorageAlerts(input: StorageAlertInput): StorageAlert[] {
  const alerts: StorageAlert[] = [];
  const { latest, latestAttempt, dayBefore } = input;

  if (!input.analyticsConfigured) {
    alerts.push({ code: 'analytics_not_configured', level: 'info' });
  }
  if (!latest || input.now.getTime() - new Date(latest.slot).getTime() > SNAPSHOT_STALE_MS) {
    alerts.push({
      code: 'snapshot_stale',
      level: 'warning',
      values: latest ? { since: latest.slot } : undefined,
    });
  }
  if (
    latestAttempt?.status === 'failed' &&
    (!latest || new Date(latestAttempt.slot) > new Date(latest.slot))
  ) {
    alerts.push({
      code: 'snapshot_failed',
      level: 'warning',
      values: { error: latestAttempt.error ?? '' },
    });
  }

  if (latest?.unexplainedBytes != null && dayBefore?.unexplainedBytes != null) {
    const growth = latest.unexplainedBytes - dayBefore.unexplainedBytes;
    if (growth > UNEXPLAINED_GROWTH_ALERT_BYTES) {
      alerts.push({ code: 'unexplained_growth', level: 'warning', values: { bytes: growth } });
    }
  }

  const classA = latest?.classAOperations;
  if (
    classA != null &&
    input.weeklyClassAAverage != null &&
    classA >= CLASS_A_SPIKE_MIN_OPERATIONS &&
    classA > input.weeklyClassAAverage * CLASS_A_SPIKE_FACTOR
  ) {
    alerts.push({
      code: 'class_a_spike',
      level: 'error',
      values: { current: classA, average: Math.round(input.weeklyClassAAverage) },
    });
  }

  const unknown = input.lastCompletedAudit?.categories.find((item) => item.category === 'other');
  if (unknown && unknown.bytes > UNKNOWN_OBJECTS_ALERT_BYTES) {
    alerts.push({
      code: 'unknown_objects',
      level: 'warning',
      values: { bytes: unknown.bytes, objects: unknown.objects },
    });
  }
  if (input.latestAudit?.status === 'failed') {
    alerts.push({
      code: 'audit_failed',
      level: 'warning',
      values: { error: input.latestAudit.error ?? '' },
    });
  }
  return alerts;
}
