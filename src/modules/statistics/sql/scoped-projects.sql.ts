import type { StatisticsScope } from '../statistics-scope.service';

/**
 * Projects a statistics request may count, as a CTE bound to `$1..$3` (see `scopeValues`); every
 * statistics query appends its own parameters from `$4`. Mirrors the project list: only admins
 * see other users' drafts (projects.service.ts `list`). Only the columns the statistics read are
 * kept, since Postgres materializes a CTE used more than once.
 */
export const SCOPED_PROJECTS_CTE = `scoped_projects AS (
  SELECT p.id, p.name, p.folder_id, p.evaluation_status, p.owner_user_id, p.created_at
  FROM projects p
  WHERE ($1::uuid[] IS NULL OR p.folder_id = ANY($1::uuid[]))
    AND ($2::boolean OR p.evaluation_status <> 'draft' OR p.owner_user_id = $3::varchar)
)`;

export function scopeValues(scope: StatisticsScope): unknown[] {
  return [scope.folderIds, scope.isAdmin, scope.userId];
}
