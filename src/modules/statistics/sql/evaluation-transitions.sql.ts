/**
 * Evaluation events that changed a media item's status, as a CTE over `scoped_projects`.
 *
 * `project_media_evaluations` also stores comment-only edits with the status unchanged, and a
 * row does not keep the previous status, so the previous row of the same media is looked up
 * (a media item starts as `pending`). Counting only real changes keeps a comment from being
 * counted as another decision. `fromParam`/`toParam` are SQL placeholders such as `$4`.
 */
export function evaluationTransitionsCte(fromParam: string, toParam?: string): string {
  const upperBound = toParam ? ` AND e.created_at < ${toParam}::timestamptz` : '';
  return `transitions AS (
  SELECT
    e.project_media_id,
    e.evaluated_by,
    e.created_at,
    e.evaluation_status AS new_status,
    COALESCE(prev.evaluation_status, 'pending') AS old_status
  FROM project_media_evaluations e
  INNER JOIN project_media pm ON pm.id = e.project_media_id
  INNER JOIN scoped_projects sp ON sp.id = pm.project_id
  LEFT JOIN LATERAL (
    SELECT x.evaluation_status
    FROM project_media_evaluations x
    WHERE x.project_media_id = e.project_media_id
      AND (x.created_at, x.id) < (e.created_at, e.id)
    ORDER BY x.created_at DESC, x.id DESC
    LIMIT 1
  ) prev ON TRUE
  WHERE e.created_at >= ${fromParam}::timestamptz${upperBound}
    AND e.evaluation_status <> COALESCE(prev.evaluation_status, 'pending')
)`;
}
