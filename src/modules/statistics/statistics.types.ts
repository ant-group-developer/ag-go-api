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
