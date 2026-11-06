/**
 * Where the audit puts an object. `group` tells the page how to read it:
 * - counted: what the statistics page counts;
 * - app: written by the app on purpose, but not in the statistics;
 * - orphan: left behind by the app, nothing refers to it any more (safe to clean up);
 * - unknown: matches no key the app writes. Objects stored with a leaked key land here.
 */
export const STORAGE_AUDIT_CATEGORIES = {
  original: 'counted',
  variant: 'counted',
  variant_not_ready: 'app',
  analysis: 'app',
  download_zip: 'app',
  documents: 'app',
  settings: 'app',
  removed_media: 'orphan',
  deleted_project: 'orphan',
  deleted_asset: 'orphan',
  legacy_project_zip: 'orphan',
  variant_untracked: 'orphan',
  original_untracked: 'orphan',
  other: 'unknown',
} as const;

export type StorageAuditCategory = keyof typeof STORAGE_AUDIT_CATEGORIES;
export type StorageAuditGroup = (typeof STORAGE_AUDIT_CATEGORIES)[StorageAuditCategory];

export type ByteCount = { objects: number; bytes: number };

/** Bytes the database knows of, by source (see EXPECTED_STORAGE_SQL). */
export type ExpectedStorageBreakdown = {
  /** Originals of assets attached to a project; one per key, as stored. */
  originals: ByteCount;
  /** Ready variants of those assets. */
  variants: ByteCount;
  /** Processing or failed variants of those assets that recorded a size. */
  variantsNotReady: ByteCount;
  /** ZIPs of downloads not yet past the lifecycle rule. */
  downloads: ByteCount;
  /** Contract templates, generated contract documents, signed scans and payment proofs. */
  documents: ByteCount;
  /** Originals and variants of assets no project uses any more (media removed). */
  removedMedia: ByteCount;
};

export type StorageAlertCode =
  | 'analytics_not_configured'
  | 'snapshot_stale'
  | 'snapshot_failed'
  | 'unexplained_growth'
  | 'class_a_spike'
  | 'unknown_objects'
  | 'audit_failed';

export type StorageAlert = {
  code: StorageAlertCode;
  level: 'info' | 'warning' | 'error';
  /** Values the message is filled with (bytes, counts, times). */
  values?: Record<string, string | number>;
};

export type StorageSnapshotView = {
  slot: string;
  status: 'running' | 'completed' | 'failed';
  /** Size Cloudflare reports (payload + metadata), null without analytics. */
  bucketBytes: number | null;
  bucketObjects: number | null;
  bucketPendingUploads: number | null;
  bucketMeasuredAt: string | null;
  expectedBytes: number | null;
  leakedBytes: number | null;
  /** Bucket minus expected minus leaked: what the database cannot account for. */
  unexplainedBytes: number | null;
  expectedBreakdown: ExpectedStorageBreakdown | null;
  /** Requests by action type over the 24 hours before the slot. */
  operations: Record<string, number> | null;
  classAOperations: number | null;
  classBOperations: number | null;
  error: string | null;
};

export type StorageAuditView = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  trigger: 'schedule' | 'manual';
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  listedObjects: number;
  listedBytes: number;
  multipartUploads: number | null;
  multipartBytes: number | null;
  categories: Array<ByteCount & { category: StorageAuditCategory; group: StorageAuditGroup }>;
  /** Top-level folders of the `other` objects, largest first. */
  otherPrefixes: Array<ByteCount & { prefix: string }>;
  /** Largest objects outside the `counted` group. */
  topObjects: Array<{ key: string; bytes: number; category: StorageAuditCategory }>;
  error: string | null;
};

export type StorageOverview = {
  bucket: string;
  analyticsConfigured: boolean;
  checkedAt: string;
  latest: StorageSnapshotView | null;
  /** Latest completed snapshot about 24 hours before `latest`, for the day-on-day change. */
  dayBefore: StorageSnapshotView | null;
  /** Completed snapshots of the last 30 days, oldest first: one per 6 hours, then the latest. */
  history: StorageSnapshotView[];
  latestAudit: StorageAuditView | null;
  /** Last completed audit, when the latest one is still queued, running or failed. */
  lastCompletedAudit: StorageAuditView | null;
  alerts: StorageAlert[];
};
