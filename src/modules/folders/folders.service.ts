import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { isAdminUserType } from '../../common/auth/user-type';
import { AccessGrantEntity } from '../../database/entities/access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import {
  FolderAccessLevel,
  FolderAccessService,
  grantReachesProjectSql,
} from './folder-access.service';

export type FolderTreeItem = FolderEntity & {
  childCount: number;
  /** Projects of the subtree the user's grants reach. */
  projectCount: number;
  /** Level on the folder itself (grants on every category); `viewer` when only categories. */
  myAccessLevel: FolderAccessLevel;
  /** Highest level on some of its projects, category-limited grants included. */
  myProjectAccessLevel: FolderAccessLevel;
  /** True when only category-limited grants reach the folder. */
  categoryLimited: boolean;
};

@Injectable()
export class FoldersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
    @InjectRepository(FolderClosureEntity)
    private readonly closureRepository: Repository<FolderClosureEntity>,
    private readonly accessService: FolderAccessService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async create(
    dto: CreateFolderDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    permissions: string[] = [],
  ): Promise<FolderEntity> {
    if (!dto.parentId) {
      this.requireRootPermission(userType, permissions);
    }
    return this.dataSource.transaction(async (manager) => {
      const parent = dto.parentId
        ? await manager.findOne(FolderEntity, { where: { id: dto.parentId, isActive: true } })
        : null;
      if (dto.parentId && !parent) {
        throw new NotFoundException('Parent folder not found');
      }
      if (parent) {
        // On the transaction's connection: a second pooled one could wait forever for a free slot.
        const canManage = await this.accessService.canAccess(
          parent.id,
          userId,
          'editor',
          userType,
          manager,
        );
        if (!canManage) {
          throw new ForbiddenException('Insufficient folder permission');
        }
      }

      const duplicate = await manager
        .createQueryBuilder(FolderEntity, 'folder')
        .where('LOWER(folder.name) = LOWER(:name)', { name: dto.name })
        .andWhere(
          dto.parentId ? 'folder.parent_id = :parentId' : 'folder.parent_id IS NULL',
          dto.parentId ? { parentId: dto.parentId } : {},
        )
        .getOne();
      if (duplicate) {
        throw new ConflictException('A folder with this name already exists');
      }

      const folder = manager.create(FolderEntity, {
        id: uuidv7(),
        parentId: parent?.id ?? null,
        name: dto.name.trim(),
        pathKey: parent ? `${parent.pathKey}/${this.slugify(dto.name)}` : this.slugify(dto.name),
        pathIds: [...(parent?.pathIds ?? []), uuidv7()],
        pathText: parent ? `${parent.pathText} / ${dto.name.trim()}` : dto.name.trim(),
        depth: (parent?.depth ?? -1) + 1,
        sortOrder: dto.sortOrder ?? 0,
        createdBy: userId,
      });
      folder.pathIds[folder.pathIds.length - 1] = folder.id;
      const saved = await manager.save(folder);

      const ancestors = parent
        ? await manager.find(FolderClosureEntity, {
            where: { descendantId: parent.id },
          })
        : [];
      await manager.insert(FolderClosureEntity, [
        { ancestorId: saved.id, descendantId: saved.id, depth: 0 },
        ...ancestors.map((entry) => ({
          ancestorId: entry.ancestorId,
          descendantId: saved.id,
          depth: entry.depth + 1,
        })),
      ]);
      await manager.insert(AccessGrantEntity, {
        id: uuidv7(),
        folderId: saved.id,
        categoryId: null,
        principalType: 'user',
        principalId: userId,
        accessLevel: 'manager',
        inheritChildren: true,
        grantedBy: userId,
      });
      return saved;
    });
  }

  /**
   * Every active folder, whatever the user's folder access, with only what a filter needs. The
   * "Projects" page lists every evaluated project, so its folder filter is not limited.
   */
  options(): Promise<
    Array<Pick<FolderEntity, 'id' | 'parentId' | 'name' | 'pathText' | 'pathIds' | 'depth'>>
  > {
    return this.folderRepository
      .createQueryBuilder('folder')
      .select([
        'folder.id',
        'folder.parentId',
        'folder.name',
        'folder.pathText',
        'folder.pathIds',
        'folder.depth',
      ])
      .addSelect('folder.name COLLATE natural_sort', 'name_sort')
      .where('folder.isActive = true')
      .orderBy('folder.depth', 'ASC')
      .addOrderBy('folder.sortOrder', 'ASC')
      .addOrderBy('name_sort', 'ASC')
      .getMany();
  }

  async tree(userId: string, userType?: 'ADMIN' | 'USER'): Promise<FolderTreeItem[]> {
    const levels = await this.accessService.folderLevels(userId, userType);
    const ids = [...levels.keys()];
    if (ids.length === 0) {
      return [];
    }
    const folders = await this.folderRepository
      .createQueryBuilder('folder')
      .addSelect('folder.name COLLATE natural_sort', 'name_sort')
      .where('folder.id IN (:...ids)', { ids })
      .andWhere('folder.isActive = true')
      .orderBy('folder.depth', 'ASC')
      .addOrderBy('folder.sortOrder', 'ASC')
      .addOrderBy('name_sort', 'ASC')
      .getMany();
    const folderIds = folders.map((folder) => folder.id);
    if (folderIds.length === 0) {
      return [];
    }

    const childCounts = new Map<string, number>();
    for (const folder of folders) {
      if (folder.parentId) {
        childCounts.set(folder.parentId, (childCounts.get(folder.parentId) ?? 0) + 1);
      }
    }

    const projectQuery = this.dataSource
      .createQueryBuilder()
      .select('folder_closure.ancestor_id', 'folderId')
      .addSelect('COUNT(project.id)', 'count')
      .from('folder_closure', 'folder_closure')
      .innerJoin('projects', 'project', 'project.folder_id = folder_closure.descendant_id')
      .where('folder_closure.ancestor_id IN (:...folderIds)', { folderIds })
      .andWhere('project.folder_id IN (:...folderIds)', { folderIds });
    if (!isAdminUserType(userType)) {
      projectQuery.andWhere(
        grantReachesProjectSql(
          {
            folderId: 'project.folder_id',
            categoryId: 'project.category_id',
            evaluationStatus: 'project.evaluation_status',
          },
          ':treeUserId',
          'viewer',
        ),
        { treeUserId: userId },
      );
    }
    const projectRows = await projectQuery
      .groupBy('folder_closure.ancestor_id')
      .getRawMany<{ folderId: string; count: string | number }>();
    const projectCounts = new Map(projectRows.map((row) => [row.folderId, Number(row.count)]));

    const items = folders.map((folder) => {
      const level = levels.get(folder.id);
      return {
        ...folder,
        childCount: childCounts.get(folder.id) ?? 0,
        projectCount: projectCounts.get(folder.id) ?? 0,
        myAccessLevel: level?.level ?? 'viewer',
        myProjectAccessLevel: level?.projectLevel ?? 'viewer',
        categoryLimited: !level?.level,
      };
    });
    return (await this.actorEnrichment.enrich(items as unknown as Array<Record<string, unknown>>, [
      { id: 'createdBy', target: 'createdByUser' },
    ])) as unknown as FolderTreeItem[];
  }

  async update(
    folderId: string,
    dto: UpdateFolderDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    permissions: string[] = [],
  ): Promise<FolderEntity> {
    await this.requireAccess(folderId, userId, 'editor', userType);
    return this.dataSource.transaction(async (manager) => {
      const moveRequested = dto.parentId !== undefined;
      if (moveRequested) {
        // Serialise moves so two concurrent ones cannot form a cycle (A under B, B under A).
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext('folders:move'))`);
      }
      const folder = await manager.findOne(FolderEntity, {
        where: { id: folderId, isActive: true },
      });
      if (!folder) {
        throw new NotFoundException('Folder not found');
      }
      const targetParentId = moveRequested ? (dto.parentId ?? null) : folder.parentId;
      const moving = targetParentId !== folder.parentId;
      const name = dto.name?.trim() || folder.name;
      const renamed = name !== folder.name;

      if (moving) {
        // Moving to the root makes a new root folder, so it needs the same right as creating one.
        if (!targetParentId) {
          this.requireRootPermission(userType, permissions);
        }
        // Moving changes which grants the subtree inherits, so it needs manager access.
        await this.requireAccessOn(manager, folderId, userId, 'manager', userType);
      }
      const parent = targetParentId
        ? await manager.findOne(FolderEntity, { where: { id: targetParentId, isActive: true } })
        : null;
      if (targetParentId && !parent) {
        throw new NotFoundException('Parent folder not found');
      }
      if (moving && parent) {
        const intoOwnSubtree = await manager.exists(FolderClosureEntity, {
          where: { ancestorId: folderId, descendantId: parent.id },
        });
        if (intoOwnSubtree) {
          throw new BadRequestException('A folder cannot be moved into itself or its subfolders');
        }
        await this.requireAccessOn(manager, parent.id, userId, 'editor', userType);
      }

      if (renamed || moving) {
        const duplicate = await manager
          .createQueryBuilder(FolderEntity, 'folder')
          .where('LOWER(folder.name) = LOWER(:name)', { name })
          .andWhere('folder.id <> :folderId', { folderId })
          .andWhere(
            targetParentId ? 'folder.parent_id = :parentId' : 'folder.parent_id IS NULL',
            targetParentId ? { parentId: targetParentId } : {},
          )
          .getOne();
        if (duplicate) {
          throw new ConflictException('A folder with this name already exists');
        }
      }

      const oldPathText = folder.pathText;
      const oldPathKey = folder.pathKey;
      const oldPathIds = folder.pathIds;
      const oldDepth = folder.depth;
      if (renamed || moving) {
        folder.name = name;
        folder.parentId = parent?.id ?? null;
        folder.pathText = parent ? `${parent.pathText} / ${name}` : name;
        folder.pathKey = parent ? `${parent.pathKey}/${this.slugify(name)}` : this.slugify(name);
        folder.pathIds = [...(parent?.pathIds ?? []), folder.id];
        folder.depth = (parent?.depth ?? -1) + 1;
      }
      if (dto.sortOrder !== undefined) {
        folder.sortOrder = dto.sortOrder;
      }
      const saved = await manager.save(folder);

      if (moving) {
        await this.reattachSubtree(manager, folderId, parent?.id ?? null);
      }

      if (saved.pathText !== oldPathText || saved.pathKey !== oldPathKey || moving) {
        const descendantIds = (
          await manager.find(FolderClosureEntity, { where: { ancestorId: folderId } })
        )
          .filter((entry) => entry.depth > 0)
          .map((entry) => entry.descendantId);
        if (descendantIds.length > 0) {
          const descendants = await manager.find(FolderEntity, {
            where: { id: In(descendantIds) },
          });
          for (const descendant of descendants) {
            descendant.pathText = saved.pathText + descendant.pathText.slice(oldPathText.length);
            descendant.pathKey = saved.pathKey + descendant.pathKey.slice(oldPathKey.length);
            descendant.pathIds = [...saved.pathIds, ...descendant.pathIds.slice(oldPathIds.length)];
            descendant.depth += saved.depth - oldDepth;
          }
          await manager.save(descendants);
        }
      }

      if (moving) {
        // The mover's manager access may have come from the old parent.
        const stillManager = await this.accessService.canAccess(
          folderId,
          userId,
          'manager',
          userType,
          manager,
        );
        if (!stillManager) {
          throw new ConflictException(
            'You cannot move this folder where you would lose manager access to it',
          );
        }
      }
      return saved;
    });
  }

  private requireRootPermission(userType: 'ADMIN' | 'USER' | undefined, permissions: string[]) {
    if (isAdminUserType(userType) || permissions.includes(GO_PERMISSIONS.FOLDER_CREATE_ROOT)) {
      return;
    }
    throw new ForbiddenException('You are not allowed to create root folders');
  }

  /** Detaches a subtree from its old ancestors in the closure table and links it under `parentId`. */
  private async reattachSubtree(
    manager: EntityManager,
    folderId: string,
    parentId: string | null,
  ): Promise<void> {
    await manager.query(
      `DELETE FROM folder_closure
       WHERE descendant_id IN (SELECT descendant_id FROM folder_closure WHERE ancestor_id = $1)
         AND ancestor_id NOT IN (SELECT descendant_id FROM folder_closure WHERE ancestor_id = $1)`,
      [folderId],
    );
    if (parentId) {
      await manager.query(
        `INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
         SELECT above.ancestor_id, below.descendant_id, above.depth + below.depth + 1
         FROM folder_closure above
         CROSS JOIN folder_closure below
         WHERE above.descendant_id = $1 AND below.ancestor_id = $2`,
        [parentId, folderId],
      );
    }
  }

  async remove(folderId: string, userId: string, userType?: 'ADMIN' | 'USER'): Promise<void> {
    await this.requireAccess(folderId, userId, 'manager', userType);
    const children = await this.folderRepository.count({
      where: { parentId: folderId, isActive: true },
    });
    const projects = await this.dataSource
      .getRepository(ProjectEntity)
      .count({ where: { folderId } });
    if (children > 0 || projects > 0) {
      throw new ConflictException('Folder must be empty before deletion');
    }
    const folder = await this.folderRepository.findOne({ where: { id: folderId } });
    if (!folder) {
      throw new NotFoundException('Folder not found');
    }
    folder.isActive = false;
    await this.folderRepository.save(folder);
  }

  private async requireAccess(
    folderId: string,
    userId: string,
    minimum: FolderAccessLevel,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    const allowed = await this.accessService.canAccess(folderId, userId, minimum, userType);
    if (!allowed) {
      throw new ForbiddenException('Insufficient folder permission');
    }
  }

  /** Like requireAccess, but on the transaction's connection. */
  private async requireAccessOn(
    manager: EntityManager,
    folderId: string,
    userId: string,
    minimum: FolderAccessLevel,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    const allowed = await this.accessService.canAccess(
      folderId,
      userId,
      minimum,
      userType,
      manager,
    );
    if (!allowed) {
      throw new ForbiddenException('Insufficient folder permission');
    }
  }

  private slugify(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }
}
