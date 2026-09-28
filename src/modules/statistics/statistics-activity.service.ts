import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import type { AuthContext } from '../../common/auth-context.service';
import { StatisticsLimitQueryDto } from './dto/statistics-limit-query.dto';
import { SCOPED_PROJECTS_CTE, scopeValues } from './sql/scoped-projects.sql';
import { StatisticsScopeService } from './statistics-scope.service';
import type { StatisticsActivity, StatisticsActivityItem } from './statistics.types';

const DEFAULT_LIMIT = 15;

/**
 * Latest project audit entries in the scope. `media_updated` (caption and order edits) is left
 * out: it is frequent and says little about progress. $4 limit.
 */
const ACTIVITY_SQL = `
WITH ${SCOPED_PROJECTS_CTE}
SELECT
  pal.id::text AS id,
  pal.action,
  pal.actor_user_id AS "actorUserId",
  pal.project_id AS "projectId",
  sp.name AS "projectName",
  pal.before_data AS "beforeData",
  pal.after_data AS "afterData",
  pal.metadata,
  asset.original_filename AS "mediaFileName",
  pal.created_at AS "createdAt"
FROM project_audit_logs pal
INNER JOIN scoped_projects sp ON sp.id = pal.project_id
LEFT JOIN project_media media ON media.id = pal.project_media_id
LEFT JOIN assets asset ON asset.id = media.asset_id
WHERE pal.action <> 'media_updated'
ORDER BY pal.created_at DESC, pal.id DESC
LIMIT $4`;

@Injectable()
export class StatisticsActivityService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly scopeService: StatisticsScopeService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async activity(
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: StatisticsLimitQueryDto,
  ): Promise<StatisticsActivity> {
    const scope = await this.scopeService.resolve(context);
    if (scope.empty) {
      return { items: [] };
    }
    const rows = (await this.dataSource.query(ACTIVITY_SQL, [
      ...scopeValues(scope),
      query.limit ?? DEFAULT_LIMIT,
    ])) as Array<Omit<StatisticsActivityItem, 'actorUser' | 'createdAt'> & { createdAt: Date }>;
    const enriched = await this.actorEnrichment.enrich<Record<string, unknown>>(
      rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() })),
      [{ id: 'actorUserId', target: 'actorUser' }],
    );
    return { items: enriched as StatisticsActivityItem[] };
  }
}
