/** Rules of the paged import history (`GET /google-drive/imports`) and its files (`.../items`). */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type ImportSortOrder = 'ASC' | 'DESC';

/** Page and page size of a list request, clamped to 1..{@link MAX_PAGE_SIZE} rows. */
export function resolvePaging(options: { page?: number; pageSize?: number }) {
  return {
    page: Math.max(Math.trunc(options.page ?? 1) || 1, 1),
    pageSize: Math.min(
      Math.max(Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE) || 1, 1),
      MAX_PAGE_SIZE,
    ),
  };
}

/** Raw `page` / `pageSize` / `search` / `sortOrder` query params, dropping invalid ones. */
export function parseListQuery(query: {
  page?: string;
  pageSize?: string;
  search?: string;
  sortOrder?: string;
}): { page?: number; pageSize?: number; search?: string; sortOrder?: ImportSortOrder } {
  const page = query.page ? Number.parseInt(query.page, 10) : undefined;
  const pageSize = query.pageSize ? Number.parseInt(query.pageSize, 10) : undefined;
  const search = query.search?.trim().slice(0, 200);
  const sortOrder = query.sortOrder?.toUpperCase();
  return {
    ...(Number.isFinite(page) ? { page } : {}),
    ...(Number.isFinite(pageSize) ? { pageSize } : {}),
    ...(search ? { search } : {}),
    ...(sortOrder === 'ASC' || sortOrder === 'DESC' ? { sortOrder } : {}),
  };
}

/** `ILIKE :search ESCAPE '!'` parameter; '!' escapes LIKE wildcards so they match literally. */
export function containsPattern(search: string) {
  return `%${search.replace(/[!%_]/g, (char) => `!${char}`)}%`;
}

/**
 * Status tabs of the history: 'active' groups batches not finished yet (queued, processing,
 * paused), 'failed' also holds the batches where only some files failed.
 */
export const IMPORT_HISTORY_STATUS_FILTERS = ['all', 'active', 'completed', 'failed'] as const;
export type ImportHistoryStatusFilter = (typeof IMPORT_HISTORY_STATUS_FILTERS)[number];
export type ImportHistoryCounts = Record<ImportHistoryStatusFilter, number>;

export function isImportHistoryStatusFilter(value: unknown): value is ImportHistoryStatusFilter {
  return IMPORT_HISTORY_STATUS_FILTERS.includes(value as ImportHistoryStatusFilter);
}

/** Status condition per tab, on the `batch` alias. */
export const IMPORT_HISTORY_STATUS_CONDITIONS: Record<
  Exclude<ImportHistoryStatusFilter, 'all'>,
  string
> = {
  active: "batch.status NOT IN ('completed', 'partial', 'failed', 'cancelled')",
  completed: "batch.status = 'completed'",
  failed: "batch.status IN ('failed', 'partial')",
};

export const IMPORT_HISTORY_SORT_FIELDS = [
  'createdAt',
  'finishedAt',
  'project',
  'fileCount',
  'totalBytes',
  'progress',
] as const;
export type ImportHistorySortField = (typeof IMPORT_HISTORY_SORT_FIELDS)[number];

export function isImportHistorySortField(value: unknown): value is ImportHistorySortField {
  return IMPORT_HISTORY_SORT_FIELDS.includes(value as ImportHistorySortField);
}

/** Files of the batch, the same rows the history's file stats count (folders excluded). */
const BATCH_FILES = `FROM asset_imports sort_item
  WHERE sort_item.batch_id = batch.id
    AND COALESCE(sort_item.source_mime_type, '') <> 'application/vnd.google-apps.folder'`;

/**
 * SQL expression per sort field, matching the values the history shows: the finish time is
 * only set once the batch is done (last file finished, else the batch's last update).
 */
export const IMPORT_HISTORY_SORT_EXPRESSIONS: Record<ImportHistorySortField, string> = {
  createdAt: 'batch.created_at',
  finishedAt: `(CASE WHEN batch.status IN ('completed', 'partial', 'failed', 'cancelled')
    THEN COALESCE((SELECT MAX(sort_item.finished_at) ${BATCH_FILES}), batch.updated_at) END)`,
  project:
    '(SELECT sort_project.name FROM projects sort_project WHERE sort_project.id = batch.project_id)',
  fileCount: `(SELECT COUNT(*) ${BATCH_FILES})`,
  totalBytes: `(SELECT COALESCE(SUM(sort_item.source_size_bytes), 0) ${BATCH_FILES})`,
  progress: 'batch.progress_percent',
};

/** Files of a batch (`GET /google-drive/imports/:batchId/items`); folders are left out. */
export const IMPORT_ITEM_STATUS_FILTERS = ['all', 'active', 'completed', 'failed'] as const;
export type ImportItemStatusFilter = (typeof IMPORT_ITEM_STATUS_FILTERS)[number];
export type ImportItemCounts = Record<ImportItemStatusFilter, number>;

export function isImportItemStatusFilter(value: unknown): value is ImportItemStatusFilter {
  return IMPORT_ITEM_STATUS_FILTERS.includes(value as ImportItemStatusFilter);
}

/** Status condition per tab, on the `item` alias; 'active' groups queued and importing files. */
export const IMPORT_ITEM_STATUS_CONDITIONS: Record<
  Exclude<ImportItemStatusFilter, 'all'>,
  string
> = {
  active: "item.status IN ('queued', 'importing')",
  completed: "item.status = 'completed'",
  failed: "item.status = 'failed'",
};

export const IMPORT_ITEM_SORT_FIELDS = [
  'createdAt',
  'name',
  'size',
  'resolution',
  'duration',
  'modifiedAt',
] as const;
export type ImportItemSortField = (typeof IMPORT_ITEM_SORT_FIELDS)[number];

export function isImportItemSortField(value: unknown): value is ImportItemSortField {
  return IMPORT_ITEM_SORT_FIELDS.includes(value as ImportItemSortField);
}

/** SQL expression per sort field: `createdAt` is the import order, resolution the pixel count. */
export const IMPORT_ITEM_SORT_EXPRESSIONS: Record<ImportItemSortField, string> = {
  createdAt: 'item.created_at',
  name: 'item.source_name',
  size: 'item.source_size_bytes',
  resolution: '(item.source_width::bigint * item.source_height)',
  duration: 'item.source_duration_seconds',
  modifiedAt: 'item.source_modified_at',
};
