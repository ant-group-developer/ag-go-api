import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsPeriodQueryDto } from './dto/statistics-period-query.dto';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { resolveStatisticsPeriod, toPeriodInfo } from './statistics-period';
import { StatisticsScopeService } from './statistics-scope.service';
import type { StatisticsProjectTrend } from './statistics.types';

/**
 * Projects created per day or week, zero-filled over the window.
 * $4 from, $5 effectiveTo, $6 time zone, $7 bucket unit ('day' | 'week').
 */
const PROJECT_TREND_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
buckets AS (
  SELECT bucket
  FROM generate_series(
    date_trunc($7::text, $4::timestamptz AT TIME ZONE $6::text),
    date_trunc($7::text, ($5::timestamptz - interval '1 millisecond') AT TIME ZONE $6::text),
    ('1 ' || $7::text)::interval
  ) AS bucket
),
created AS (
  SELECT date_trunc($7::text, created_at AT TIME ZONE $6::text) AS bucket, COUNT(*)::int AS projects
  FROM scoped_projects
  WHERE created_at >= $4::timestamptz AND created_at < $5::timestamptz
  GROUP BY 1
)
SELECT to_char(b.bucket, 'YYYY-MM-DD') AS "bucketStart", COALESCE(c.projects, 0)::int AS projects
FROM buckets b
LEFT JOIN created c ON c.bucket = b.bucket
ORDER BY b.bucket`;

@Injectable()
export class StatisticsProjectTrendService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
  ) {}

  async projectTrend(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsPeriodQueryDto,
  ): Promise<StatisticsProjectTrend> {
    const period = resolveStatisticsPeriod(query);
    const scope = await this.scopeService.resolve(context);
    // Users without any folder still get the zero-filled buckets: an empty folder list matches
    // no project. The bucket unit comes from the server-side granularity, never the request.
    const rows = (await this.dataSource.query(PROJECT_TREND_SQL, [
      ...scopeValues(scope),
      period.from,
      period.effectiveTo,
      period.timeZone,
      period.granularity,
    ])) as Array<{ bucketStart: string; projects: number }>;

    const points = rows.map((row) => ({
      bucketStart: row.bucketStart,
      projects: Number(row.projects ?? 0),
    }));
    return {
      period: toPeriodInfo(period),
      total: points.reduce((sum, point) => sum + point.projects, 0),
      points,
    };
  }
}
