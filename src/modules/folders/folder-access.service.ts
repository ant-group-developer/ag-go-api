import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { isAdminUserType } from '../../common/auth/user-type';
import { CategoryAccessGrantEntity } from '../../database/entities/category-access-grant.entity';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import type { ProjectEntity } from '../../database/entities/project.entity';

const accessRank = {
  viewer: 1,
  editor: 2,
  manager: 3,
} as const;

export type FolderAccessLevel = keyof typeof accessRank;

/** Statuses a category grant reaches: the evaluated projects listed on the "Projects" page. */
export const CATEGORY_GRANT_PROJECT_STATUSES: ReadonlyArray<ProjectEntity['evaluationStatus']> = [
  'completed',
  'partially_completed',
];

export type ProjectViewTarget = Pick<
  ProjectEntity,
  'folderId' | 'categoryId' | 'ownerUserId' | 'evaluationStatus'
>;

export function maxAccessLevel(
  left: FolderAccessLevel | undefined,
  right: FolderAccessLevel,
): FolderAccessLevel {
  return left && accessRank[left] >= accessRank[right] ? left : right;
}

@Injectable()
export class FolderAccessService {
  constructor(
    @InjectRepository(FolderAccessGrantEntity)
    private readonly grantRepository: Repository<FolderAccessGrantEntity>,
    @InjectRepository(FolderClosureEntity)
    private readonly closureRepository: Repository<FolderClosureEntity>,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
    @InjectRepository(CategoryAccessGrantEntity)
    private readonly categoryGrantRepository: Repository<CategoryAccessGrantEntity>,
  ) {}

  /**
   * Read access to one project: its folder (viewer), its owner, or a category grant when the
   * project is evaluated. Edits keep requiring folder access through `canAccess`.
   */
  async canViewProject(
    project: ProjectViewTarget,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    manager?: EntityManager,
  ): Promise<boolean> {
    if (isAdminUserType(userType) || project.ownerUserId === userId) {
      return true;
    }
    if (await this.canAccess(project.folderId, userId, 'viewer', userType, manager)) {
      return true;
    }
    if (
      !project.categoryId ||
      !CATEGORY_GRANT_PROJECT_STATUSES.includes(project.evaluationStatus)
    ) {
      return false;
    }
    const categoryGrantRepository =
      manager?.getRepository(CategoryAccessGrantEntity) ?? this.categoryGrantRepository;
    return categoryGrantRepository.exists({
      where: { categoryId: project.categoryId, principalType: 'user', principalId: userId },
    });
  }

  /** Categories granted to a user (admins need none: they see every category). */
  async grantedCategoryIds(userId: string): Promise<string[]> {
    const grants = await this.categoryGrantRepository.find({
      select: { categoryId: true },
      where: { principalType: 'user', principalId: userId },
    });
    return grants.map((grant) => grant.categoryId);
  }

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
    const closureRepository = manager?.getRepository(FolderClosureEntity) ?? this.closureRepository;
    const grantRepository = manager?.getRepository(FolderAccessGrantEntity) ?? this.grantRepository;
    const closure = await closureRepository.find({
      where: { descendantId: folderId },
    });
    if (closure.length === 0) {
      return false;
    }

    const ancestorIds = closure.map((entry) => entry.ancestorId);
    const grants = await grantRepository
      .createQueryBuilder('grant')
      .where('grant.folder_id IN (:...ancestorIds)', { ancestorIds })
      .andWhere('grant.principal_type = :userType AND grant.principal_id = :userId', {
        userType: 'user',
        userId,
      })
      .getMany();

    return grants.some((grant) => {
      const relation = closure.find((entry) => entry.ancestorId === grant.folderId);
      const applies = relation?.depth === 0 || grant.inheritChildren;
      return Boolean(applies && accessRank[grant.accessLevel] >= accessRank[minimum]);
    });
  }

  async accessibleFolderIds(userId: string, userType?: 'ADMIN' | 'USER'): Promise<string[]> {
    return [...(await this.accessLevels(userId, userType)).keys()];
  }

  /** Effective (highest) access level of a user on every folder they can reach. */
  async accessLevels(
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<Map<string, FolderAccessLevel>> {
    const levels = new Map<string, FolderAccessLevel>();
    if (isAdminUserType(userType)) {
      const folders = await this.folderRepository.find({ select: { id: true } });
      for (const folder of folders) {
        levels.set(folder.id, 'manager');
      }
      return levels;
    }
    const grants = await this.grantRepository
      .createQueryBuilder('grant')
      .where('grant.principal_type = :userType AND grant.principal_id = :userId', {
        userType: 'user',
        userId,
      })
      .getMany();
    if (grants.length === 0) {
      return levels;
    }
    const grantsByFolder = new Map<string, FolderAccessGrantEntity[]>();
    for (const grant of grants) {
      grantsByFolder.set(grant.folderId, [...(grantsByFolder.get(grant.folderId) ?? []), grant]);
    }
    const closure = await this.closureRepository.find({
      where: { ancestorId: In([...grantsByFolder.keys()]) },
    });

    for (const relation of closure) {
      for (const grant of grantsByFolder.get(relation.ancestorId) ?? []) {
        if (relation.depth === 0 || grant.inheritChildren) {
          levels.set(
            relation.descendantId,
            maxAccessLevel(levels.get(relation.descendantId), grant.accessLevel),
          );
        }
      }
    }

    return levels;
  }
}
