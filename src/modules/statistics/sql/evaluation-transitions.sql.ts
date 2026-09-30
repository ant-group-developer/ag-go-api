/**
 * Evaluation events that changed a media item's status, as a CTE over `scoped_projects`.
 *
 * `project_media_evaluations` also stores comment-only edits with the status unchanged. Each row
 * keeps the status it replaced (`previous_status`, filled by a trigger), so counting only real
 * changes keeps a comment from being counted as another decision, and the rows of the window are
 * found through the `created_at` index. `fromParam`/`toParam` are SQL placeholders such as `$4`.
 */
export function evaluationTransitionsCte(fromParam: string, toParam?: string): string {
  const upperBound = toParam ? ` AND e.created_at < ${toParam}::timestamptz` : '';
  return `transitions AS (
  SELECT
    e.project_media_id,
    e.evaluated_by,
    e.created_at,
    e.evaluation_status AS new_status,
    e.previous_status AS old_status
  FROM project_media_evaluations e
  INNER JOIN project_media pm ON pm.id = e.project_media_id
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
  WHERE e.created_at >= ${fromParam}::timestamptz${upperBound}
    AND e.evaluation_status <> e.previous_status
)`;
}
