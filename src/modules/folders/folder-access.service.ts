import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';

const accessRank = {
  viewer: 1,
  editor: 2,
  manager: 3,
} as const;

export type FolderAccessLevel = keyof typeof accessRank;

@Injectable()
export class FolderAccessService {
  constructor(
    @InjectRepository(FolderAccessGrantEntity)
    private readonly grantRepository: Repository<FolderAccessGrantEntity>,
    @InjectRepository(FolderClosureEntity)
    private readonly closureRepository: Repository<FolderClosureEntity>,
  ) {}

  async canAccess(folderId: string, userId: string, minimum: FolderAccessLevel): Promise<boolean> {
    const closure = await this.closureRepository.find({
      where: { descendantId: folderId },
    });
    if (closure.length === 0) {
      return false;
    }

    const ancestorIds = closure.map((entry) => entry.ancestorId);
    const grants = await this.grantRepository
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

  async accessibleFolderIds(userId: string): Promise<string[]> {
    const closure = await this.closureRepository.find();
    const grants = await this.grantRepository
      .createQueryBuilder('grant')
      .where('grant.principal_type = :userType AND grant.principal_id = :userId', {
        userType: 'user',
        userId,
      })
      .getMany();
    const accessible = new Set<string>();

    for (const relation of closure) {
      const hasGrant = grants.some(
        (grant) =>
          grant.folderId === relation.ancestorId &&
          (relation.depth === 0 || grant.inheritChildren) &&
          accessRank[grant.accessLevel] >= accessRank.viewer,
      );
      if (hasGrant) {
        accessible.add(relation.descendantId);
      }
    }

    return [...accessible];
  }
}
