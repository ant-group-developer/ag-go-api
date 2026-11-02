import type { EntityManager } from 'typeorm';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import { EVALUATED_STATUSES } from '../pricing-facts/pricing-facts';

export const PACKAGE_AUDIT_CATEGORY = 'package';

/** Rows of an `UPDATE ... RETURNING` (the Postgres driver answers `[rows, affected]`). */
function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

/**
 * Moves the package of `projectId` (if any) with the evaluation of its projects (FR-K-06):
 * submitted → evaluated once every project is evaluated (final status, no media pending), and
 * evaluated → submitted when one goes back to pending while no acceptance record holds it. Called
 * whenever a project's evaluation status is recalculated, and when a package is submitted.
 */
export async function refreshPackageProgress(
  manager: EntityManager,
  packageId: string,
): Promise<'evaluated' | 'submitted' | null> {
  const [state] = (await manager.query(
    `SELECT package.status, package.acceptance_id AS "acceptanceId",
            count(project.id) AS projects,
            count(project.id) FILTER (
              WHERE project.evaluation_status = ANY($2::varchar[])
                AND NOT EXISTS (SELECT 1 FROM project_media media
                                WHERE media.project_id = project.id AND media.evaluation_status = 'pending')
            ) AS evaluated
     FROM product_packages package
     LEFT JOIN projects project ON project.package_id = package.id
     WHERE package.id = $1
     GROUP BY package.id`,
    [packageId, EVALUATED_STATUSES],
  )) as Array<{ status: string; acceptanceId: string | null; projects: string; evaluated: string }>;
  if (!state) {
    return null;
  }
  const all = Number(state.projects) > 0 && Number(state.projects) === Number(state.evaluated);
  let moved: 'evaluated' | 'submitted' | null = null;
  if (state.status === 'submitted' && all) {
    const rows = returnedRows(
      await manager.query(
        `UPDATE product_packages SET status = 'evaluated', evaluated_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'submitted' RETURNING id`,
        [packageId],
      ),
    );
    moved = rows.length > 0 ? 'evaluated' : null;
  } else if (state.status === 'evaluated' && !all && !state.acceptanceId) {
    const rows = returnedRows(
      await manager.query(
        `UPDATE product_packages SET status = 'submitted', evaluated_at = NULL, updated_at = now()
         WHERE id = $1 AND status = 'evaluated' AND acceptance_id IS NULL RETURNING id`,
        [packageId],
      ),
    );
    moved = rows.length > 0 ? 'submitted' : null;
  }
  if (moved) {
    await manager.insert(SystemLogEntity, {
      level: 'info',
      category: PACKAGE_AUDIT_CATEGORY,
      action: moved === 'evaluated' ? 'PACKAGE_EVALUATED' : 'PACKAGE_EVALUATION_REOPENED',
      message: `Package ${packageId} ${moved} after the evaluation of its projects`,
      userId: 'system',
      metadata: { packageId },
    });
  }
  return moved;
}

/** As refreshPackageProgress, from one of the package's projects. */
export async function refreshProjectPackage(
  manager: EntityManager,
  projectId: string,
): Promise<void> {
  const [row] = (await manager.query(
    `SELECT package_id AS "packageId" FROM projects WHERE id = $1`,
    [projectId],
  )) as Array<{ packageId: string | null }>;
  if (row?.packageId) {
    await refreshPackageProgress(manager, row.packageId);
  }
}
