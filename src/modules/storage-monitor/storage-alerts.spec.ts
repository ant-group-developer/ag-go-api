import { buildStorageAlerts, type StorageAlertInput } from './storage-alerts';
import type { StorageAuditView, StorageSnapshotView } from './storage-monitor.types';

const NOW = new Date('2026-11-04T10:30:00Z');

function snapshot(overrides: Partial<StorageSnapshotView> = {}): StorageSnapshotView {
  return {
    slot: '2026-11-04T10:00:00.000Z',
    status: 'completed',
    bucketBytes: 14_520e9,
    bucketObjects: 1_000_000,
    bucketPendingUploads: 0,
    bucketMeasuredAt: '2026-11-04T09:55:00.000Z',
    expectedBytes: 13_000e9,
    leakedBytes: 1_000e9,
    unexplainedBytes: 520e9,
    expectedBreakdown: null,
    operations: null,
    classAOperations: 5_000,
    classBOperations: 50_000,
    error: null,
    ...overrides,
  };
}

function audit(overrides: Partial<StorageAuditView> = {}): StorageAuditView {
  return {
    id: 'a1',
    status: 'completed',
    trigger: 'schedule',
    requestedBy: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    listedObjects: 0,
    listedBytes: 0,
    multipartUploads: 0,
    multipartBytes: 0,
    categories: [],
    otherPrefixes: [],
    topObjects: [],
    error: null,
    ...overrides,
  };
}

function input(overrides: Partial<StorageAlertInput> = {}): StorageAlertInput {
  const latest = snapshot();
  return {
    now: NOW,
    analyticsConfigured: true,
    latest,
    latestAttempt: latest,
    dayBefore: snapshot({ slot: '2026-11-03T10:00:00.000Z', unexplainedBytes: 510e9 }),
    weeklyClassAAverage: 4_000,
    latestAudit: audit(),
    lastCompletedAudit: audit(),
    ...overrides,
  };
}

const codes = (value: StorageAlertInput) => buildStorageAlerts(value).map((alert) => alert.code);

describe('buildStorageAlerts', () => {
  it('raises nothing when the bucket behaves', () => {
    expect(codes(input())).toEqual([]);
  });

  it('says when Cloudflare analytics are not configured', () => {
    expect(codes(input({ analyticsConfigured: false }))).toContain('analytics_not_configured');
  });

  it('warns when no snapshot was taken for three hours, or ever', () => {
    expect(codes(input({ latest: snapshot({ slot: '2026-11-04T06:00:00.000Z' }) }))).toContain(
      'snapshot_stale',
    );
    expect(codes(input({ latest: null, latestAttempt: null, dayBefore: null }))).toContain(
      'snapshot_stale',
    );
  });

  it('reports a failed snapshot newer than the last good one', () => {
    const failed = snapshot({
      slot: '2026-11-04T11:00:00.000Z',
      status: 'failed',
      error: 'HTTP 403',
    });
    expect(buildStorageAlerts(input({ latestAttempt: failed }))).toContainEqual({
      code: 'snapshot_failed',
      level: 'warning',
      values: { error: 'HTTP 403' },
    });
  });

  it('warns when unexplained bytes grow by more than 50 GB in a day', () => {
    expect(
      buildStorageAlerts(input({ latest: snapshot({ unexplainedBytes: 600e9 }) })),
    ).toContainEqual({ code: 'unexplained_growth', level: 'warning', values: { bytes: 90e9 } });
    expect(codes(input({ latest: snapshot({ unexplainedBytes: 550e9 }) }))).not.toContain(
      'unexplained_growth',
    );
  });

  it('flags class A operations far above the weekly average, past a floor', () => {
    expect(codes(input({ latest: snapshot({ classAOperations: 30_000 }) }))).toContain(
      'class_a_spike',
    );
    // Over three times the average but below the floor: a quiet bucket.
    expect(
      codes(input({ weeklyClassAAverage: 1_000, latest: snapshot({ classAOperations: 15_000 }) })),
    ).not.toContain('class_a_spike');
    expect(codes(input({ weeklyClassAAverage: null }))).not.toContain('class_a_spike');
  });

  it('warns about objects outside every key the app writes', () => {
    const lastCompletedAudit = audit({
      categories: [{ category: 'other', group: 'unknown', objects: 12, bytes: 5e9 }],
    });
    expect(codes(input({ lastCompletedAudit }))).toContain('unknown_objects');
  });

  it('reports a failed audit', () => {
    expect(codes(input({ latestAudit: audit({ status: 'failed', error: 'denied' }) }))).toContain(
      'audit_failed',
    );
  });
});
