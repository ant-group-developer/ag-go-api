import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { isAdminUserType } from '../../common/auth/user-type';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';

const accessRank = {
  viewer: 1,
  editor: 2,
  manager: 3,
} as const;

export type FolderAccessLevel = keyof typeof accessRank;

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
  ) {}

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
