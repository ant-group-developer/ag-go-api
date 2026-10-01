import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsPeriodQueryDto } from './dto/statistics-period-query.dto';
import { evaluationTransitionsCte } from './sql/evaluation-transitions.sql';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { resolveStatisticsPeriod, toPeriodInfo } from './statistics-period';
import { StatisticsScopeService } from './statistics-scope.service';
import { buildTrendSeries, type TrendEventRow } from './statistics-trend-series';
import type { StatisticsTrend } from './statistics.types';

/** $4 from, $5 effectiveTo, $6 time zone, $7 bucket unit ('day' | 'week'). */
const BUCKETS_SQL = `
WITH ${SCOPED_PROJECTS_CTE}
SELECT
  (
    SELECT COUNT(*)::int
    FROM project_media pm
    INNER JOIN scoped_projects sp ON sp.id = pm.project_id
    WHERE pm.evaluation_status = 'pending'
  ) AS "currentPending",
  ARRAY(
    SELECT to_char(bucket, 'YYYY-MM-DD')
    FROM generate_series(
      date_trunc($7::text, $4::timestamptz AT TIME ZONE $6::text),
      date_trunc($7::text, ($5::timestamptz - interval '1 millisecond') AT TIME ZONE $6::text),
      ('1 ' || $7::text)::interval
    ) AS bucket
    ORDER BY bucket
  ) AS "bucketStarts"`;

/**
 * Every backlog change since the start of the window, including those after it ended (tail),
 * which are needed to rebuild the backlog backwards from today's pending count.
 */
const EVENTS_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
${evaluationTransitionsCte('$4')},
events AS (
  SELECT pm.created_at AS happened_at, 1 AS added, 0 AS approved, 0 AS rejected, 1 AS backlog_delta
  FROM project_media pm
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
  WHERE pm.created_at >= $4::timestamptz
  UNION ALL
  SELECT
    t.created_at,
    0,
    (t.new_status = 'approved')::int,
    (t.new_status = 'rejected')::int,
    (t.new_status = 'pending')::int - (t.old_status = 'pending')::int
  FROM transitions t
)
SELECT
  to_char(date_trunc($7::text, happened_at AT TIME ZONE $6::text), 'YYYY-MM-DD') AS "bucketStart",
  (happened_at >= $5::timestamptz) AS "isTail",
  SUM(added)::int AS added,
  SUM(approved)::int AS approved,
  SUM(rejected)::int AS rejected,
  SUM(backlog_delta)::int AS "backlogDelta"
FROM events
GROUP BY 1, 2`;

@Injectable()
export class StatisticsTrendService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
  ) {}

  async trend(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsPeriodQueryDto,
  ): Promise<StatisticsTrend> {
    const period = resolveStatisticsPeriod(query);
    const scope = await this.scopeService.resolve(context);
    // Bucket unit comes from the server-side granularity, never from the request.
    const values = [
      ...scopeValues(scope),
      period.from,
      period.effectiveTo,
      period.timeZone,
      period.granularity,
    ];

    // Both queries run in parallel; the events are only skipped when the scope has no project.
    const [[bucketRow], rows] = (await Promise.all([
      this.dataSource.query(BUCKETS_SQL, values),
      scope.empty ? [] : this.dataSource.query(EVENTS_SQL, values),
    ])) as [Array<{ currentPending: number; bucketStarts: string[] }>, TrendEventRow[]];
    const bucketStarts = bucketRow?.bucketStarts ?? [];
    if (scope.empty || bucketStarts.length === 0) {
      return {
        period: toPeriodInfo(period),
        points: buildTrendSeries(bucketStarts, [], 0),
      };
    }

    return {
      period: toPeriodInfo(period),
      points: buildTrendSeries(bucketStarts, rows, Number(bucketRow?.currentPending ?? 0)),
    };
  }
}
