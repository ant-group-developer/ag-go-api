import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { isAdminUserType } from '../../common/auth/user-type';
import { currentRequestPermissions } from '../../common/request-context';
import { AccessGrantEntity, type AccessLevel } from '../../database/entities/access-grant.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import type { ProjectEntity } from '../../database/entities/project.entity';

export type { AccessLevel } from '../../database/entities/access-grant.entity';

const accessRank: Record<AccessLevel, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
};

/** Levels that act on a folder itself (all of them since grants are always on a folder). */
export type FolderAccessLevel = AccessLevel;

/**
 * Evaluated projects: the "Projects" page lists them (all of them with `go.project.read_all`),
 * and the only ones an originals bundle reaches.
 */
export const EVALUATED_PROJECT_STATUSES: ReadonlyArray<ProjectEntity['evaluationStatus']> = [
  'completed',
  'partially_completed',
];

export type ProjectAccessTarget = Pick<
  ProjectEntity,
  'folderId' | 'categoryId' | 'ownerUserId' | 'evaluationStatus'
>;

export function maxAccessLevel<T extends AccessLevel>(left: T | undefined, right: T): T {
  return left && accessRank[left] >= accessRank[right] ? left : right;
}

export function accessLevelRank(level: AccessLevel): number {
  return accessRank[level];
}

function levelsFrom(minimum: AccessLevel): AccessLevel[] {
  return (Object.keys(accessRank) as AccessLevel[]).filter(
    (level) => accessRank[level] >= accessRank[minimum],
  );
}

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** SQL expressions of the project a scope condition tests. */
export type ProjectColumnsSql = {
  folderId: string;
  categoryId: string;
  evaluationStatus: string;
};

/**
 * SQL condition, true when a work grant of `level >= minimum` reaches the project: its folder
 * (or an ancestor whose grant is inherited) and its category (or every category). `userIdSql`
 * is the user id parameter (`:userId` for query builders, `$3::varchar` for raw queries).
 * Owners and admins are the caller's business.
 */
export function grantReachesProjectSql(
  project: ProjectColumnsSql,
  userIdSql: string,
  minimum: AccessLevel,
): string {
  return `EXISTS (
    SELECT 1 FROM access_grants scope_grant
    JOIN folder_closure scope_closure ON scope_closure.ancestor_id = scope_grant.folder_id
    WHERE scope_grant.principal_type = 'user'
      AND scope_grant.principal_id = ${userIdSql}
      AND scope_grant.access_level IN (${sqlList(levelsFrom(minimum))})
      AND (scope_grant.category_id IS NULL OR scope_grant.category_id = ${project.categoryId})
      AND scope_closure.descendant_id = ${project.folderId}
      AND (scope_closure.depth = 0 OR scope_grant.inherit_children)
  )`;
}

/**
 * SQL condition, true when one of the user's originals bundles reaches the project: one of its
 * folders holds it (subfolders included) and one of its categories is the project's. Says
 * nothing about the project's status; see `originalsReachProjectSql`.
 */
export function bundleReachesProjectSql(project: ProjectColumnsSql, userIdSql: string): string {
  return `EXISTS (
    SELECT 1 FROM original_access_bundles scope_bundle
    WHERE scope_bundle.principal_type = 'user'
      AND scope_bundle.principal_id = ${userIdSql}
      AND EXISTS (
        SELECT 1 FROM original_access_bundle_categories scope_bundle_category
        WHERE scope_bundle_category.bundle_id = scope_bundle.id
          AND scope_bundle_category.category_id = ${project.categoryId}
      )
      AND EXISTS (
        SELECT 1 FROM original_access_bundle_folders scope_bundle_folder
        JOIN folder_closure scope_bundle_closure
          ON scope_bundle_closure.ancestor_id = scope_bundle_folder.folder_id
        WHERE scope_bundle_folder.bundle_id = scope_bundle.id
          AND scope_bundle_closure.descendant_id = ${project.folderId}
      )
  )`;
}

/**
 * SQL condition, true when the user may see a project's originals: a bundle reaching it once
 * it is evaluated, or a work grant (`viewer` or more) whatever its status. Owners and admins are
 * the caller's business.
 */
export function originalsReachProjectSql(project: ProjectColumnsSql, userIdSql: string): string {
  return `(
    (${project.evaluationStatus} IN (${sqlList(EVALUATED_PROJECT_STATUSES)})
      AND ${bundleReachesProjectSql(project, userIdSql)})
    OR ${grantReachesProjectSql(project, userIdSql, 'viewer')}
  )`;
}

/**
 * Who can do what. Work grants (`access_grants`) cover the projects of a folder (and its
 * subfolders when inherited) in a category (or every category); folder work (subfolders, moves,
 * folder render batches, grants) needs one on every category. Originals bundles
 * (`original_access_bundles`) open the originals of evaluated projects.
 */
@Injectable()
export class FolderAccessService {
  constructor(
    @InjectRepository(AccessGrantEntity)
    private readonly grantRepository: Repository<AccessGrantEntity>,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
  ) {}

  /**
   * Every evaluated project on "Projects" (watermarked unless the user may see its originals):
   * admins and users with `go.project.read_all`. `permissions` defaults to the current request's.
   */
  canReadAllProjects(
    userType?: 'ADMIN' | 'USER',
    permissions: readonly string[] | undefined = currentRequestPermissions(),
  ): boolean {
    return (
      isAdminUserType(userType) || Boolean(permissions?.includes(GO_PERMISSIONS.PROJECT_READ_ALL))
    );
  }

  /**
   * Reading a project: admins, its owner, a `viewer` grant, and for an evaluated project
   * `go.project.read_all` (watermarked, see `canSeeOriginals`) or a bundle reaching it.
   * `permissions` defaults to the current request's.
   */
  async canViewProject(
    project: ProjectAccessTarget,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    manager?: EntityManager,
    permissions: readonly string[] | undefined = currentRequestPermissions(),
  ): Promise<boolean> {
    if (isAdminUserType(userType) || project.ownerUserId === userId) {
      return true;
    }
    if (
      EVALUATED_PROJECT_STATUSES.includes(project.evaluationStatus) &&
      (this.canReadAllProjects(userType, permissions) ||
        (await this.bundleReachesProject(project, userId, manager)))
    ) {
      return true;
    }
    return this.canAccessProject(project, userId, 'viewer', userType, manager);
  }

  /**
   * Un-watermarked previews and original files of a project: admins, its owner, a `viewer`
   * grant, or a bundle reaching it once it is evaluated. Role permissions (evaluate / download
   * originals) are checked by the caller.
   */
  async canSeeOriginals(
    project: ProjectAccessTarget,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    manager?: EntityManager,
  ): Promise<boolean> {
    if (isAdminUserType(userType) || project.ownerUserId === userId) {
      return true;
    }
    if (
      EVALUATED_PROJECT_STATUSES.includes(project.evaluationStatus) &&
      (await this.bundleReachesProject(project, userId, manager))
    ) {
      return true;
    }
    return this.canAccessProject(project, userId, 'viewer', userType, manager);
  }

  /** Whether a work grant of at least `minimum` reaches the project (owners get nothing extra). */
  async canAccessProject(
    project: Pick<ProjectEntity, 'folderId' | 'categoryId' | 'evaluationStatus'>,
    userId: string,
    minimum: AccessLevel,
    userType?: 'ADMIN' | 'USER',
    manager?: EntityManager,
  ): Promise<boolean> {
    if (isAdminUserType(userType)) {
      return true;
    }
    const level = await this.projectLevel(project, userId, manager);
    return Boolean(level && accessRank[level] >= accessRank[minimum]);
  }

  /** Highest level the user's work grants give on a project (null: none reaches it). */
  async projectLevel(
    project: Pick<ProjectEntity, 'folderId' | 'categoryId'>,
    userId: string,
    manager?: EntityManager,
  ): Promise<AccessLevel | null> {
    const rows = (await (manager ?? this.grantRepository.manager).query(
      `SELECT g.access_level AS level
       FROM access_grants g
       JOIN folder_closure c ON c.ancestor_id = g.folder_id
       WHERE g.principal_type = 'user'
         AND g.principal_id = $1
         AND (g.category_id IS NULL OR g.category_id = $3::uuid)
         AND c.descendant_id = $2::uuid
         AND (c.depth = 0 OR g.inherit_children)`,
      [userId, project.folderId, project.categoryId],
    )) as Array<{ level: AccessLevel }>;
    let best: AccessLevel | null = null;
    for (const { level } of rows) {
      best = maxAccessLevel(best ?? undefined, level);
    }
    return best;
  }

  /** Whether one of the user's bundles covers the project's folder and category. */
  async bundleReachesProject(
    project: Pick<ProjectEntity, 'folderId' | 'categoryId'>,
    userId: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    if (!project.categoryId) {
      return false;
    }
    const rows = (await (manager ?? this.grantRepository.manager).query(
      `SELECT 1 WHERE ${bundleReachesProjectSql(
        { folderId: '$2::uuid', categoryId: '$3::uuid', evaluationStatus: 'NULL' },
        '$1::varchar',
      )}`,
      [userId, project.folderId, project.categoryId],
    )) as unknown[];
    return rows.length > 0;
  }

  /** Of `projectIds`, those whose originals the user may see (owners and admins included). */
  async projectIdsWithOriginals(
    projectIds: string[],
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<Set<string>> {
    if (isAdminUserType(userType)) {
      return new Set(projectIds);
    }
    if (projectIds.length === 0) {
      return new Set();
    }
    const rows = (await this.grantRepository.manager.query(
      `SELECT p.id
       FROM projects p
       WHERE p.id = ANY($1::uuid[])
         AND (p.owner_user_id = $2::varchar OR ${originalsReachProjectSql(
           {
             folderId: 'p.folder_id',
             categoryId: 'p.category_id',
             evaluationStatus: 'p.evaluation_status',
           },
           '$2::varchar',
         )})`,
      [projectIds, userId],
    )) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  /** Access to a folder itself, from work grants covering every category. */
  async canAccess(
    folderId: string,
    userId: string,
    minimum: FolderAccessLevel,
    userType?: 'ADMIN' | 'USER',
    manager?: EntityManager,
  ): Promise<boolean> {
    if (isAdminUserType(userType)) {
      return true;
    }
    const rows = (await (manager ?? this.grantRepository.manager).query(
      `SELECT 1
       FROM access_grants g
       JOIN folder_closure c ON c.ancestor_id = g.folder_id
       WHERE g.principal_type = 'user'
         AND g.principal_id = $1
         AND g.category_id IS NULL
         AND g.access_level IN (${sqlList(levelsFrom(minimum))})
         AND c.descendant_id = $2::uuid
         AND (c.depth = 0 OR g.inherit_children)
       LIMIT 1`,
      [userId, folderId],
    )) as unknown[];
    return rows.length > 0;
  }

  /**
   * Folders the user reaches with a work grant of at least `minimum`, whether or not it is
   * limited to categories (list queries add `grantReachesProjectSql` for those). Admins: every
   * folder.
   */
  async accessibleFolderIds(
    userId: string,
    userType?: 'ADMIN' | 'USER',
    minimum: AccessLevel = 'viewer',
  ): Promise<string[]> {
    if (isAdminUserType(userType)) {
      const folders = await this.folderRepository.find({ select: { id: true } });
      return folders.map((folder) => folder.id);
    }
    const rows = (await this.grantRepository.manager.query(
      `SELECT DISTINCT c.descendant_id AS id
       FROM access_grants g
       JOIN folder_closure c ON c.ancestor_id = g.folder_id
       WHERE g.principal_type = 'user'
         AND g.principal_id = $1
         AND g.access_level IN (${sqlList(levelsFrom(minimum))})
         AND (c.depth = 0 OR g.inherit_children)`,
      [userId],
    )) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * The user's level on every folder their work grants reach. `level` comes from grants on every
   * category (null when only category-limited grants reach the folder: its projects of those
   * categories, not the folder itself); `projectLevel` from all of them.
   */
  async folderLevels(
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<Map<string, { level: FolderAccessLevel | null; projectLevel: FolderAccessLevel }>> {
    const levels = new Map<
      string,
      { level: FolderAccessLevel | null; projectLevel: FolderAccessLevel }
    >();
    if (isAdminUserType(userType)) {
      for (const id of await this.accessibleFolderIds(userId, userType)) {
        levels.set(id, { level: 'manager', projectLevel: 'manager' });
      }
      return levels;
    }
    const rows = (await this.grantRepository.manager.query(
      `SELECT c.descendant_id AS "folderId", g.access_level AS level,
              g.category_id IS NULL AS "everyCategory"
       FROM access_grants g
       JOIN folder_closure c ON c.ancestor_id = g.folder_id
       WHERE g.principal_type = 'user'
         AND g.principal_id = $1
         AND (c.depth = 0 OR g.inherit_children)`,
      [userId],
    )) as Array<{ folderId: string; level: FolderAccessLevel; everyCategory: boolean }>;
    for (const row of rows) {
      const current = levels.get(row.folderId);
      levels.set(row.folderId, {
        level: row.everyCategory
          ? maxAccessLevel(current?.level ?? undefined, row.level)
          : (current?.level ?? null),
        projectLevel: maxAccessLevel(current?.projectLevel, row.level),
      });
    }
    return levels;
  }

  /** Folders the user manages (a `manager` grant, always on every category). */
  async managedFolderIds(userId: string, userType?: 'ADMIN' | 'USER'): Promise<string[]> {
    return this.accessibleFolderIds(userId, userType, 'manager');
  }
}
