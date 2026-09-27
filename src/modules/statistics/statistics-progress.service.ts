import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsLimitQueryDto } from './dto/statistics-limit-query.dto';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { StatisticsScopeService } from './statistics-scope.service';
import type {
  StatisticsAttentionProject,
  StatisticsFolderProgress,
  StatisticsProgress,
} from './statistics.types';

const DEFAULT_LIMIT = 10;

/** Evaluation counts of every scoped project. */
const PER_PROJECT_CTE = `per_project AS (
  SELECT
    sp.id,
    sp.name,
    sp.folder_id,
    sp.evaluation_status,
    COUNT(pm.id)::int AS media,
    COUNT(pm.id) FILTER (WHERE pm.evaluation_status = 'approved')::int AS approved,
    COUNT(pm.id) FILTER (WHERE pm.evaluation_status = 'rejected')::int AS rejected,
    COUNT(pm.id) FILTER (WHERE pm.evaluation_status = 'pending')::int AS pending,
    MIN(pm.created_at) FILTER (WHERE pm.evaluation_status = 'pending') AS oldest_pending_at
  FROM scoped_projects sp
  LEFT JOIN project_media pm ON pm.project_id = sp.id
  GROUP BY sp.id, sp.name, sp.folder_id, sp.evaluation_status
)`;

/**
 * One row per folder that directly holds projects, labelled with its full path (as the project
 * list does). Rows never merge projects of folders the user cannot access. Busiest first.
 */
const FOLDERS_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
${PER_PROJECT_CTE}
SELECT
  f.id AS "folderId",
  f.name AS "folderName",
  f.path_text AS "folderPath",
  COUNT(*)::int AS projects,
  SUM(pp.media)::int AS media,
  SUM(pp.approved)::int AS approved,
  SUM(pp.rejected)::int AS rejected,
  SUM(pp.pending)::int AS pending,
  (COUNT(*) OVER ())::int AS total
FROM per_project pp
INNER JOIN folders f ON f.id = pp.folder_id
GROUP BY f.id, f.name, f.path_text
ORDER BY SUM(pp.pending) DESC, SUM(pp.media) DESC, f.path_text ASC
LIMIT $4`;

/** Projects with media still waiting, the longest-waiting first. */
const ATTENTION_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
${PER_PROJECT_CTE}
SELECT
  pp.id AS "projectId",
  pp.name AS "projectName",
  f.path_text AS "folderPath",
  pp.evaluation_status AS "evaluationStatus",
  pp.media,
  pp.approved,
  pp.rejected,
  pp.pending,
  pp.oldest_pending_at AS "oldestPendingAt",
  (COUNT(*) OVER ())::int AS total
FROM per_project pp
INNER JOIN folders f ON f.id = pp.folder_id
WHERE pp.pending > 0
ORDER BY pp.oldest_pending_at ASC, pp.name ASC
LIMIT $4`;

type WithTotal<T> = T & { total: number };

@Injectable()
export class StatisticsProgressService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
  ) {}

  async progress(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsLimitQueryDto,
  ): Promise<StatisticsProgress> {
    const scope = await this.scopeService.resolve(context);
    if (scope.empty) {
      return { folders: { total: 0, items: [] }, attentionProjects: { total: 0, items: [] } };
    }
    const values = [...scopeValues(scope), query.limit ?? DEFAULT_LIMIT];
    const folderRows = (await this.dataSource.query(FOLDERS_SQL, values)) as Array<
      WithTotal<StatisticsFolderProgress>
    >;
    const attentionRows = (await this.dataSource.query(ATTENTION_SQL, values)) as Array<
      WithTotal<StatisticsAttentionProject & { oldestPendingAt: Date | string | null }>
    >;

    return {
      folders: {
        total: folderRows[0]?.total ?? 0,
        items: folderRows.map(withoutTotal),
      },
      attentionProjects: {
        total: attentionRows[0]?.total ?? 0,
        items: attentionRows.map((row) => ({
          ...withoutTotal(row),
          oldestPendingAt: row.oldestPendingAt ? new Date(row.oldestPendingAt).toISOString() : null,
        })),
      },
    };
  }
}

/** Drops the window-function `total` repeated on every row. */
function withoutTotal<T extends { total: number }>(row: T): Omit<T, 'total'> {
  const item: Partial<T> = { ...row };
  delete item.total;
  return item as Omit<T, 'total'>;
}
