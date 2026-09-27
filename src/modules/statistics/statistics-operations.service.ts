import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsPeriodQueryDto } from './dto/statistics-period-query.dto';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { resolveStatisticsPeriod, toPeriodInfo } from './statistics-period';
import { StatisticsScopeService } from './statistics-scope.service';
import type {
  StatisticsImportProblem,
  StatisticsOperations,
  StatisticsPeriodInfo,
} from './statistics.types';

/**
 * $4 from, $5 effectiveTo. Queued/processing are the live queue; finished states count jobs that
 * ended in the window (every finishing path sets `finished_at`, which is indexed). A job belongs
 * to the scope when its asset is used by a scoped project: EXISTS (not a join) so an asset shared
 * by several projects does not count its jobs twice.
 */
const RENDER_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
scoped_jobs AS (
  SELECT j.status, j.started_at, j.finished_at
  FROM media_render_jobs j
  WHERE EXISTS (
      SELECT 1
      FROM project_media pm
      INNER JOIN scoped_projects sp ON sp.id = pm.project_id
      WHERE pm.asset_id = j.asset_id
    )
    AND (
      j.status IN ('queued', 'processing')
      OR (
        j.status IN ('completed', 'failed', 'cancelled')
        AND j.finished_at >= $4::timestamptz
        AND j.finished_at < $5::timestamptz
      )
    )
)
SELECT
  COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
  COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
  COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
  COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
  COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
  COALESCE(
    AVG(EXTRACT(EPOCH FROM (finished_at - started_at)))
      FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL),
    0
  )::float AS "averageRenderSeconds"
FROM scoped_jobs`;

/** Running and paused imports are live; finished states count batches that ended in the window. */
const IMPORTS_SQL = `
WITH ${SCOPED_PROJECTS_CTE}
SELECT
  COUNT(*) FILTER (WHERE b.status IN ('queued', 'processing'))::int AS active,
  COUNT(*) FILTER (WHERE b.status = 'paused')::int AS paused,
  COUNT(*) FILTER (WHERE b.status = 'completed' AND b.updated_at >= $4::timestamptz AND b.updated_at < $5::timestamptz)::int AS completed,
  COUNT(*) FILTER (WHERE b.status = 'partial' AND b.updated_at >= $4::timestamptz AND b.updated_at < $5::timestamptz)::int AS partial,
  COUNT(*) FILTER (WHERE b.status = 'failed' AND b.updated_at >= $4::timestamptz AND b.updated_at < $5::timestamptz)::int AS failed
FROM import_batches b
INNER JOIN scoped_projects sp ON sp.id = b.project_id`;

const IMPORT_PROBLEMS_SQL = `
WITH ${SCOPED_PROJECTS_CTE}
SELECT
  b.id,
  b.project_id AS "projectId",
  sp.name AS "projectName",
  b.status,
  b.total_items AS "totalItems",
  b.failed_items AS "failedItems",
  b.updated_at AS "updatedAt"
FROM import_batches b
INNER JOIN scoped_projects sp ON sp.id = b.project_id
WHERE b.status IN ('failed', 'partial')
  AND b.updated_at >= $4::timestamptz
  AND b.updated_at < $5::timestamptz
ORDER BY b.updated_at DESC
LIMIT 5`;

@Injectable()
export class StatisticsOperationsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
  ) {}

  async operations(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsPeriodQueryDto,
  ): Promise<StatisticsOperations> {
    const period = resolveStatisticsPeriod(query);
    const periodInfo = toPeriodInfo(period);
    const scope = await this.scopeService.resolve(context);
    if (scope.empty) {
      return emptyOperations(periodInfo);
    }

    const values = [...scopeValues(scope), period.from, period.effectiveTo];
    const [renderRows, importRows, problems] = (await Promise.all([
      this.dataSource.query(RENDER_SQL, values),
      this.dataSource.query(IMPORTS_SQL, values),
      this.dataSource.query(IMPORT_PROBLEMS_SQL, values),
    ])) as [
      Array<StatisticsOperations['render']>,
      Array<Omit<StatisticsOperations['imports'], 'recentProblems'>>,
      Array<StatisticsImportProblem & { updatedAt: Date | string }>,
    ];
    const [render] = renderRows;
    const [imports] = importRows;
    const empty = emptyOperations(periodInfo);

    return {
      period: periodInfo,
      render: {
        ...empty.render,
        ...render,
        averageRenderSeconds: Number(render?.averageRenderSeconds ?? 0),
      },
      imports: {
        ...empty.imports,
        ...imports,
        recentProblems: problems.map((problem) => ({
          ...problem,
          updatedAt: new Date(problem.updatedAt).toISOString(),
        })),
      },
    };
  }
}

function emptyOperations(period: StatisticsPeriodInfo): StatisticsOperations {
  return {
    period,
    render: {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      averageRenderSeconds: 0,
    },
    imports: { active: 0, paused: 0, completed: 0, partial: 0, failed: 0, recentProblems: [] },
  };
}
