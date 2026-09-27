import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsPeriodQueryDto } from './dto/statistics-period-query.dto';
import { evaluationTransitionsCte } from './sql/evaluation-transitions.sql';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { resolveStatisticsPeriod, toPeriodInfo } from './statistics-period';
import { StatisticsScopeService } from './statistics-scope.service';
import type {
  StatisticsContributor,
  StatisticsEvaluator,
  StatisticsTeam,
} from './statistics.types';

const TOP_LIMIT = 10;

/** $4 from, $5 effectiveTo. Decisions are status changes to approved/rejected in the window. */
const EVALUATORS_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
${evaluationTransitionsCte('$4', '$5')}
SELECT
  evaluated_by AS "userId",
  COUNT(*) FILTER (WHERE new_status = 'approved')::int AS approved,
  COUNT(*) FILTER (WHERE new_status = 'rejected')::int AS rejected,
  COUNT(*)::int AS total
FROM transitions
WHERE new_status IN ('approved', 'rejected')
GROUP BY evaluated_by
ORDER BY total DESC, evaluated_by ASC
LIMIT ${TOP_LIMIT}`;

/** $4 from, $5 effectiveTo. Media added (uploads and imports) and projects created. */
const CONTRIBUTORS_SQL = `
WITH ${SCOPED_PROJECTS_CTE},
uploads AS (
  SELECT pm.created_by AS user_id, COUNT(*)::int AS media_added
  FROM project_media pm
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
  WHERE pm.created_at >= $4::timestamptz AND pm.created_at < $5::timestamptz
  GROUP BY pm.created_by
),
created AS (
  SELECT owner_user_id AS user_id, COUNT(*)::int AS projects_created
  FROM scoped_projects
  WHERE created_at >= $4::timestamptz AND created_at < $5::timestamptz
  GROUP BY owner_user_id
)
SELECT
  COALESCE(u.user_id, c.user_id) AS "userId",
  COALESCE(c.projects_created, 0)::int AS "projectsCreated",
  COALESCE(u.media_added, 0)::int AS "mediaAdded"
FROM uploads u
FULL OUTER JOIN created c ON c.user_id = u.user_id
ORDER BY "mediaAdded" DESC, "projectsCreated" DESC, "userId" ASC
LIMIT ${TOP_LIMIT}`;

@Injectable()
export class StatisticsTeamService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async team(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsPeriodQueryDto,
  ): Promise<StatisticsTeam> {
    const period = resolveStatisticsPeriod(query);
    const periodInfo = toPeriodInfo(period);
    const scope = await this.scopeService.resolve(context);
    if (scope.empty) {
      return { period: periodInfo, evaluators: [], contributors: [] };
    }

    const values = [...scopeValues(scope), period.from, period.effectiveTo];
    const [evaluators, contributors] = (await Promise.all([
      this.dataSource.query(EVALUATORS_SQL, values),
      this.dataSource.query(CONTRIBUTORS_SQL, values),
    ])) as [Array<Omit<StatisticsEvaluator, 'user'>>, Array<Omit<StatisticsContributor, 'user'>>];

    // One Account API call for both lists; rows keep their order, so they are split back by index.
    const enriched = await this.actorEnrichment.enrich<Record<string, unknown>>(
      [...evaluators, ...contributors],
      [{ id: 'userId', target: 'user' }],
    );
    return {
      period: periodInfo,
      evaluators: enriched.slice(0, evaluators.length) as StatisticsEvaluator[],
      contributors: enriched.slice(evaluators.length) as StatisticsContributor[],
    };
  }
}
