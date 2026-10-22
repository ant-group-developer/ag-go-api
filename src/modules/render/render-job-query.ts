/** Status tabs of the auto render job list; 'active' groups queued and processing jobs. */
export const AUTO_JOB_STATUS_FILTERS = [
  'all',
  'active',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AutoJobStatusFilter = (typeof AUTO_JOB_STATUS_FILTERS)[number];

export function isAutoJobStatusFilter(value: unknown): value is AutoJobStatusFilter {
  return AUTO_JOB_STATUS_FILTERS.includes(value as AutoJobStatusFilter);
}

export type AutoJobCounts = Record<AutoJobStatusFilter, number>;

export const EMPTY_JOB_COUNTS: AutoJobCounts = {
  all: 0,
  active: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
};

/**
 * Sortable columns of the auto render job list: when the job was queued, when processing
 * started, and how long processing took (finished - started).
 */
export const AUTO_JOB_SORT_FIELDS = ['createdAt', 'startedAt', 'elapsed'] as const;
export type AutoJobSortField = (typeof AUTO_JOB_SORT_FIELDS)[number];
export type AutoJobSortOrder = 'ASC' | 'DESC';

export function isAutoJobSortField(value: unknown): value is AutoJobSortField {
  return AUTO_JOB_SORT_FIELDS.includes(value as AutoJobSortField);
}

/** Paging, status tab, search and sort of a render job list. */
export type RenderJobPageOptions = {
  page?: number;
  pageSize?: number;
  status?: AutoJobStatusFilter;
  search?: string;
  sortBy?: AutoJobSortField;
  sortOrder?: AutoJobSortOrder;
};
