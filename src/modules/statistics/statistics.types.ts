/** Response shapes of the statistics endpoints (see docs/05-api-contract.md). */

export type StatisticsGranularity = 'day' | 'week';

export type StatisticsPeriodInfo = {
  from: string;
  to: string;
  effectiveTo: string;
  previousFrom: string;
  previousTo: string;
  granularity: StatisticsGranularity;
  timeZone: string;
};

/** A count in the requested period and in the previous period of the same length. */
export type PeriodCount = { current: number; previous: number };

export type ProjectStatusCounts = {
  draft: number;
  pending: number;
  completed: number;
  partially_completed: number;
  failed: number;
};

export type StatisticsSummary = {
  period: StatisticsPeriodInfo;
  snapshot: {
    projects: number;
    projectsByStatus: ProjectStatusCounts;
    media: { total: number; images: number; videos: number };
    evaluation: {
      pending: number;
      approved: number;
      rejected: number;
      oldestPendingAt: string | null;
    };
    storage: { originalBytes: string; renderedBytes: string };
  };
  inPeriod: {
    newProjects: PeriodCount;
    newMedia: PeriodCount;
    decisions: { approved: PeriodCount; rejected: PeriodCount };
  };
};

export type StatisticsTrendPoint = {
  /** Local date (YYYY-MM-DD) the day or ISO week starts on. */
  bucketStart: string;
  added: number;
  approved: number;
  rejected: number;
  /** Media still waiting for evaluation at the end of the bucket. */
  backlog: number;
};

export type StatisticsTrend = {
  period: StatisticsPeriodInfo;
  points: StatisticsTrendPoint[];
};

export type EvaluationBreakdown = {
  media: number;
  approved: number;
  rejected: number;
  pending: number;
};

export type StatisticsFolderProgress = EvaluationBreakdown & {
  folderId: string;
  folderName: string;
  folderPath: string;
  projects: number;
};

export type StatisticsAttentionProject = EvaluationBreakdown & {
  projectId: string;
  projectName: string;
  folderPath: string;
  evaluationStatus: string;
  oldestPendingAt: string | null;
};

export type StatisticsProgress = {
  folders: { total: number; items: StatisticsFolderProgress[] };
  attentionProjects: { total: number; items: StatisticsAttentionProject[] };
};

export type StatisticsEvaluator = {
  userId: string;
  user: unknown;
  approved: number;
  rejected: number;
  total: number;
};

export type StatisticsContributor = {
  userId: string;
  user: unknown;
  projectsCreated: number;
  mediaAdded: number;
};

export type StatisticsTeam = {
  period: StatisticsPeriodInfo;
  evaluators: StatisticsEvaluator[];
  contributors: StatisticsContributor[];
};

export type StatisticsImportProblem = {
  id: string;
  projectId: string;
  projectName: string;
  status: string;
  totalItems: number;
  failedItems: number;
  updatedAt: string;
};

export type StatisticsOperations = {
  period: StatisticsPeriodInfo;
  render: {
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
    averageRenderSeconds: number;
  };
  imports: {
    active: number;
    paused: number;
    completed: number;
    partial: number;
    failed: number;
    recentProblems: StatisticsImportProblem[];
  };
};

export type StatisticsActivityItem = {
  id: string;
  action: string;
  actorUserId: string;
  actorUser: unknown;
  projectId: string;
  projectName: string;
  beforeData: unknown;
  afterData: unknown;
  metadata: unknown;
  /** Current name of the file the entry is about, when it still exists. */
  mediaFileName: string | null;
  createdAt: string;
};

export type StatisticsActivity = { items: StatisticsActivityItem[] };

export type StatisticsProjectTrendPoint = {
  /** Local date (YYYY-MM-DD) the day or ISO week starts on. */
  bucketStart: string;
  /** Projects created in the bucket. */
  projects: number;
};

export type StatisticsProjectTrend = {
  period: StatisticsPeriodInfo;
  /** Projects created in the whole period (sum of the points). */
  total: number;
  points: StatisticsProjectTrendPoint[];
};

export const STATISTICS_BREAKDOWN_DIMENSIONS = [
  'category',
  'country',
  'tag',
  'resolution',
  'extension',
] as const;
export type StatisticsBreakdownDimension = (typeof STATISTICS_BREAKDOWN_DIMENSIONS)[number];

/** `all`: everything in scope today; `period`: projects created and media added in the period. */
export const STATISTICS_BREAKDOWN_RANGES = ['all', 'period'] as const;
export type StatisticsBreakdownRange = (typeof STATISTICS_BREAKDOWN_RANGES)[number];

/** Short-edge classes of the source file, highest first. */
export const STATISTICS_RESOLUTION_CLASSES = [
  '8k',
  '4k',
  '1440p',
  '1080p',
  '720p',
  '480p',
  'sd',
] as const;
export type StatisticsResolutionClass = (typeof STATISTICS_RESOLUTION_CLASSES)[number];

export type StatisticsBreakdownRow = {
  /**
   * Category, country or tag id; resolution class; lower-case extension. Null groups the projects
   * without a category/country/tag, or the media whose size or extension is unknown.
   */
  key: string | null;
  /** Name of the category, country or tag (null for resolution and extension). */
  label: string | null;
  /** Country code and flag, only for the country dimension. */
  code: string | null;
  flagUrl: string | null;
  /**
   * Projects of the group. For resolution and extension: projects having at least one media of
   * the group, so a project can be counted in several rows.
   */
  projects: number;
  media: number;
  images: number;
  videos: number;
};

export type StatisticsBreakdown = {
  period: StatisticsPeriodInfo;
  dimension: StatisticsBreakdownDimension;
  range: StatisticsBreakdownRange;
  /**
   * Sums of the rows where each project and media falls in one row: `projects` is null for
   * resolution and extension (a project's media can span several rows), and tags, which repeat
   * projects and their media, have no totals.
   */
  totals: { projects: number | null; media: number; images: number; videos: number } | null;
  rows: StatisticsBreakdownRow[];
};
