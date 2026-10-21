import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { isAdminUserType } from '../../common/auth/user-type';
import { AccessGrantEntity, type AccessLevel } from '../../database/entities/access-grant.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import type { ProjectEntity } from '../../database/entities/project.entity';

export type { AccessLevel } from '../../database/entities/access-grant.entity';

const accessRank: Record<AccessLevel, number> = {
  original: 1,
  viewer: 2,
  editor: 3,
  manager: 4,
};

/** Levels that act on a folder itself; `original` only reaches evaluated projects. */
export type FolderAccessLevel = Exclude<AccessLevel, 'original'>;

/**
 * Evaluated projects: listed on the "Projects" page for everyone who may read projects (with
 * watermarked previews), and the only ones an `original` grant reaches.
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
 * SQL condition, true when a grant of `level >= minimum` reaches the project: its folder (or an
 * ancestor whose grant is inherited, or every folder) and its category (or every category);
 * `original` grants only reach evaluated projects. `userIdSql` is the user id parameter
 * (`:userId` for query builders, `$3::varchar` for raw queries). Owners and admins are the
 * caller's business.
 */
export function grantReachesProjectSql(
  project: ProjectColumnsSql,
  userIdSql: string,
  minimum: AccessLevel,
): string {
  const levels = levelsFrom(minimum);
  const originalClause = levels.includes('original')
    ? `AND (scope_grant.access_level <> 'original'
           OR ${project.evaluationStatus} IN (${sqlList(EVALUATED_PROJECT_STATUSES)}))`
    : '';
  return `EXISTS (
    SELECT 1 FROM access_grants scope_grant
    WHERE scope_grant.principal_type = 'user'
      AND scope_grant.principal_id = ${userIdSql}
      AND scope_grant.access_level IN (${sqlList(levels)})
      ${originalClause}
      AND (scope_grant.category_id IS NULL OR scope_grant.category_id = ${project.categoryId})
      AND (
        scope_grant.folder_id IS NULL
        OR EXISTS (
          SELECT 1 FROM folder_closure scope_closure
          WHERE scope_closure.ancestor_id = scope_grant.folder_id
            AND scope_closure.descendant_id = ${project.folderId}
            AND (scope_closure.depth = 0 OR scope_grant.inherit_children)
        )
      )
  )`;
}

/**
 * Who can do what, from `access_grants`. A grant covers the projects of a folder (and its
 * subfolders when inherited) in a category (or every category). Folder work (subfolders, moves,
 * folder render batches, grants) needs a grant on every category; project work needs one that
 * reaches the project.
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
   * Reading a project: admins, its owner, everyone for evaluated projects (watermarked, see
   * `canSeeOriginals`), else a `viewer` grant.
   */
  async canViewProject(
    project: ProjectAccessTarget,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    manager?: EntityManager,
  ): Promise<boolean> {
    if (
      isAdminUserType(userType) ||
      project.ownerUserId === userId ||
      EVALUATED_PROJECT_STATUSES.includes(project.evaluationStatus)
    ) {
      return true;
    }
    return this.canAccessProject(project, userId, 'viewer', userType, manager);
  }

  /**
   * Un-watermarked previews and original files of a project: admins, its owner and users with an
   * `original` grant reaching it. Role permissions (evaluate / download originals) are checked
   * by the caller.
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
    return this.canAccessProject(project, userId, 'original', userType, manager);
  }

  /** Whether a grant of at least `minimum` reaches the project (owners get nothing extra). */
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

  /** Highest level the user's grants give on a project (null: none reaches it). */
  async projectLevel(
    project: Pick<ProjectEntity, 'folderId' | 'categoryId' | 'evaluationStatus'>,
    userId: string,
    manager?: EntityManager,
  ): Promise<AccessLevel | null> {
    const rows = (await (manager ?? this.grantRepository.manager).query(
      `SELECT g.access_level AS level
       FROM access_grants g
       WHERE g.principal_type = 'user'
         AND g.principal_id = $1
         AND (g.category_id IS NULL OR g.category_id = $3::uuid)
         AND (
           g.folder_id IS NULL
           OR EXISTS (
             SELECT 1 FROM folder_closure c
             WHERE c.ancestor_id = g.folder_id
               AND c.descendant_id = $2::uuid
               AND (c.depth = 0 OR g.inherit_children)
           )
         )`,
      [userId, project.folderId, project.categoryId],
    )) as Array<{ level: AccessLevel }>;
    const evaluated = EVALUATED_PROJECT_STATUSES.includes(project.evaluationStatus);
    let best: AccessLevel | null = null;
    for (const { level } of rows) {
      if (level === 'original' && !evaluated) {
        continue;
      }
      best = maxAccessLevel(best ?? undefined, level);
    }
    return best;
  }

  /** Of `projectIds`, those a grant of at least `minimum` reaches (admins: all of them). */
  async projectIdsWithAccess(
    projectIds: string[],
    userId: string,
    minimum: AccessLevel,
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
         AND ${grantReachesProjectSql(
           {
             folderId: 'p.folder_id',
             categoryId: 'p.category_id',
             evaluationStatus: 'p.evaluation_status',
           },
           '$2::varchar',
           minimum,
         )}`,
      [projectIds, userId],
    )) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  /** Access to a folder itself, from grants covering every category. */
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
   * Folders the user reaches with a grant of at least `minimum`, whether or not it is limited to
   * categories (list queries add `grantReachesProjectSql` for those). Admins: every folder.
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
   * The user's level on every folder they reach with a `viewer` grant or more. `level` comes from
   * grants on every category (null when only category-limited grants reach the folder: its
   * projects of those categories, not the folder itself); `projectLevel` from all of them.
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
         AND g.access_level <> 'original'
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
