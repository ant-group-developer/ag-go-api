import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { isAdminUserType } from '../../common/auth/user-type';
import { FolderAccessService } from '../folders/folder-access.service';

export type SegmentVisibilityContext = {
  userId: string;
  userType?: 'ADMIN' | 'USER';
  /** Pre-computed accessible folder IDs (pass to avoid double-fetch). */
  folderIds?: string[];
};

/**
 * Computes which media_segments are visible to a user based on folder access grants.
 *
 * Visibility rule (from plan S5 / 2.1):
 *   A segment is visible when its asset belongs to at least one project_media link where:
 *     - project.folder_id is in the user's accessible folders
 *     - project.evaluation_status <> 'draft' OR project.owner_user_id = $userId   (ADMIN skips)
 *     - project_media.evaluation_status <> 'rejected'
 *   AND segment.is_current = true.
 *
 *   Out of scope (no visible link) → 404.
 */
@Injectable()
export class FootageScopeService {
  constructor(
    private readonly folderAccess: FolderAccessService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Returns accessible folder IDs for the user. */
  async getAccessibleFolderIds(userId: string, userType?: 'ADMIN' | 'USER'): Promise<string[]> {
    return this.folderAccess.accessibleFolderIds(userId, userType);
  }

  /**
   * Converts a SQL string with `:namedParam` placeholders and a params object into
   * a positional-params pair suitable for `DataSource.query()` with the pg driver.
   * Each unique name maps to one `$N` index; order of first occurrence determines N.
   */
  static toPositional(
    sql: string,
    named: Record<string, unknown>,
  ): { sql: string; params: unknown[] } {
    const vals: unknown[] = [];
    const seen = new Map<string, number>();
    const out = sql.replace(/:([a-zA-Z_]\w*)/g, (_, key: string) => {
      if (!seen.has(key)) {
        seen.set(key, vals.push(named[key]));
      }
      return `$${seen.get(key)!}`;
    });
    return { sql: out, params: vals };
  }

  /**
   * Builds the SQL CTE fragment for visible projects given known parameters.
   * Returns the CTE SQL string and named parameters.
   *
   * Usage: embed as the first CTE and join with it as `vp`.
   */
  buildVisibleProjectsCte(
    isAdmin: boolean,
    folderIds: string[],
    userId: string,
  ): { cte: string; params: Record<string, unknown> } {
    if (isAdmin) {
      return {
        cte: `visible_projects AS (SELECT id FROM projects)`,
        params: {},
      };
    }
    if (folderIds.length === 0) {
      return {
        cte: `visible_projects AS (SELECT id FROM projects WHERE FALSE)`,
        params: {},
      };
    }
    return {
      cte: `visible_projects AS (
        SELECT p.id
        FROM projects p
        WHERE p.folder_id = ANY(:vp_folder_ids)
          AND (p.evaluation_status <> 'draft' OR p.owner_user_id = :vp_user_id)
      )`,
      params: { vp_folder_ids: folderIds, vp_user_id: userId },
    };
  }

  /**
   * Returns a parameterized EXISTS sub-query that is TRUE when the given segment alias `s`
   * has at least one non-rejected project_media in a visible project.
   *
   * The caller must have already defined the `visible_projects` CTE.
   */
  visibleExistsClause(segmentAlias = 's'): string {
    return `EXISTS (
      SELECT 1
      FROM project_media pm
      JOIN visible_projects vp ON vp.id = pm.project_id
      WHERE pm.asset_id = ${segmentAlias}.asset_id
        AND pm.evaluation_status <> 'rejected'
    )`;
  }

  /**
   * Returns TRUE if the segment has at least one approved link in scope.
   * The caller must have already defined the `visible_projects` CTE.
   */
  approvedExistsClause(segmentAlias = 's'): string {
    return `EXISTS (
      SELECT 1
      FROM project_media pm
      JOIN visible_projects vp ON vp.id = pm.project_id
      WHERE pm.asset_id = ${segmentAlias}.asset_id
        AND pm.evaluation_status = 'approved'
    )`;
  }

  /**
   * Asserts that all provided segmentIds are in scope for the user.
   * Throws NotFoundException for any id that is not visible.
   */
  async assertSegmentsInScope(segmentIds: string[], ctx: SegmentVisibilityContext): Promise<void> {
    if (segmentIds.length === 0) return;

    const folderIds =
      ctx.folderIds ?? (await this.folderAccess.accessibleFolderIds(ctx.userId, ctx.userType));
    const isAdmin = isAdminUserType(ctx.userType);

    const { cte, params } = this.buildVisibleProjectsCte(isAdmin, folderIds, ctx.userId);
    const rawSql = `
      WITH ${cte}
      SELECT s.id
      FROM media_segments s
      WHERE s.id = ANY(:seg_ids)
        AND s.is_current = true
        AND ${this.visibleExistsClause('s')}
    `;

    const { sql, params: positional } = FootageScopeService.toPositional(rawSql, {
      ...params,
      seg_ids: segmentIds,
    });
    const rows = (await this.dataSource.query(sql, positional)) as Array<{ id: string }>;

    const found = new Set(rows.map((r) => r.id));
    const missing = segmentIds.find((id) => !found.has(id));
    if (missing) {
      throw new NotFoundException(`Segment not found or not in scope: ${missing}`);
    }
  }

  /**
   * Asserts that all provided folderIds are accessible to the user.
   * Throws NotFoundException for any folder outside the scope.
   */
  async assertFoldersInScope(
    requestedFolderIds: string[],
    accessibleFolderIds: string[],
  ): Promise<void> {
    const accessible = new Set(accessibleFolderIds);
    const missing = requestedFolderIds.find((id) => !accessible.has(id));
    if (missing) {
      throw new NotFoundException(`Folder not found or not accessible: ${missing}`);
    }
  }

  /**
   * Expands the folders a caller picked to their whole subtree (like the project list's folder
   * filter), keeping only the folders the user can reach: picking "Test" also covers
   * "Test / Test 1 / Test 1.1".
   */
  async expandToAccessibleSubtree(
    requestedFolderIds: string[],
    accessibleFolderIds: string[],
  ): Promise<string[]> {
    if (requestedFolderIds.length === 0) return [];
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT descendant_id AS id FROM folder_closure WHERE ancestor_id = ANY($1::uuid[])`,
      [requestedFolderIds],
    )) as Array<{ id: string }>;
    const accessible = new Set(accessibleFolderIds);
    return [...new Set([...requestedFolderIds, ...rows.map((r) => r.id)])].filter((id) =>
      accessible.has(id),
    );
  }
}
