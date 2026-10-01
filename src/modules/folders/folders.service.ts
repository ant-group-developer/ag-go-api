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
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { CreateFolderDto } from './dto/create-folder.dto';
import { SetFolderGrantDto } from './dto/set-folder-grant.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { UpsertFolderGrantDto } from './dto/upsert-folder-grant.dto';
import { FolderAccessLevel, FolderAccessService } from './folder-access.service';

export type FolderTreeItem = FolderEntity & {
  childCount: number;
  projectCount: number;
  myAccessLevel: FolderAccessLevel;
};

type GrantSourceFolder = { id: string; name: string; pathText: string; depth: number };

export type FolderGrantsResult = {
  direct: FolderAccessGrantEntity[];
  inherited: Array<FolderAccessGrantEntity & { sourceFolder: GrantSourceFolder | null }>;
};

export type UserFolderGrant = FolderAccessGrantEntity & {
  folder: { id: string; name: string; pathText: string; pathIds: string[] };
};

@Injectable()
export class FoldersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
    @InjectRepository(FolderClosureEntity)
    private readonly closureRepository: Repository<FolderClosureEntity>,
    @InjectRepository(FolderAccessGrantEntity)
    private readonly grantRepository: Repository<FolderAccessGrantEntity>,
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
      await manager.insert(FolderAccessGrantEntity, {
        id: uuidv7(),
        folderId: saved.id,
        principalType: 'user',
        principalId: userId,
        accessLevel: 'manager',
        inheritChildren: true,
        grantedBy: userId,
      });
      return saved;
    });
  }

  async tree(userId: string, userType?: 'ADMIN' | 'USER'): Promise<FolderTreeItem[]> {
    const levels = await this.accessService.accessLevels(userId, userType);
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

    const projectRows = await this.dataSource
      .createQueryBuilder()
      .select('folder_closure.ancestor_id', 'folderId')
      .addSelect('COUNT(project.id)', 'count')
      .from('folder_closure', 'folder_closure')
      .innerJoin('projects', 'project', 'project.folder_id = folder_closure.descendant_id')
      .where('folder_closure.ancestor_id IN (:...folderIds)', { folderIds })
      .andWhere('project.folder_id IN (:...folderIds)', { folderIds })
      .groupBy('folder_closure.ancestor_id')
      .getRawMany<{ folderId: string; count: string | number }>();
    const projectCounts = new Map(projectRows.map((row) => [row.folderId, Number(row.count)]));

    const items = folders.map((folder) => ({
      ...folder,
      childCount: childCounts.get(folder.id) ?? 0,
      projectCount: projectCounts.get(folder.id) ?? 0,
      myAccessLevel: levels.get(folder.id) ?? 'viewer',
    }));
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

  async grants(
    folderId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<FolderGrantsResult> {
    await this.requireAccess(folderId, userId, 'manager', userType);
    const direct = await this.grantRepository.find({
      where: { folderId },
      order: { createdAt: 'ASC' },
    });

    const ancestors = await this.closureRepository
      .createQueryBuilder('closure')
      .where('closure.descendant_id = :folderId AND closure.depth > 0', { folderId })
      .getMany();
    const ancestorFolders = ancestors.length
      ? await this.folderRepository.find({
          where: { id: In(ancestors.map((entry) => entry.ancestorId)), isActive: true },
        })
      : [];
    const ancestorById = new Map(ancestorFolders.map((folder) => [folder.id, folder]));
    const inheritedGrants = ancestorById.size
      ? await this.grantRepository.find({
          where: { folderId: In([...ancestorById.keys()]), inheritChildren: true },
        })
      : [];
    const inherited = inheritedGrants
      .map((grant) => {
        const source = ancestorById.get(grant.folderId);
        return {
          ...grant,
          sourceFolder: source
            ? { id: source.id, name: source.name, pathText: source.pathText, depth: source.depth }
            : null,
        };
      })
      .sort((a, b) => (b.sourceFolder?.depth ?? 0) - (a.sourceFolder?.depth ?? 0));

    const actorFields = [
      { id: 'principalId', target: 'principalUser' },
      { id: 'grantedBy', target: 'grantedByUser' },
    ];
    return {
      direct: (await this.actorEnrichment.enrich(
        direct as unknown as Array<Record<string, unknown>>,
        actorFields,
      )) as unknown as FolderAccessGrantEntity[],
      inherited: (await this.actorEnrichment.enrich(
        inherited as unknown as Array<Record<string, unknown>>,
        actorFields,
      )) as unknown as FolderGrantsResult['inherited'],
    };
  }

  async setGrant(
    folderId: string,
    principalId: string,
    dto: SetFolderGrantDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<FolderAccessGrantEntity> {
    await this.requireAccess(folderId, userId, 'manager', userType);
    await this.requireActiveFolder(folderId);
    return this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(FolderAccessGrantEntity, {
        where: { folderId, principalType: 'user', principalId },
      });
      const grant =
        existing ??
        manager.create(FolderAccessGrantEntity, {
          id: uuidv7(),
          folderId,
          principalType: 'user',
          principalId,
        });
      grant.accessLevel = dto.accessLevel;
      grant.inheritChildren = dto.inheritChildren ?? existing?.inheritChildren ?? true;
      grant.grantedBy = userId;
      const saved = await manager.save(grant);
      await this.ensureStillManager(manager, folderId, userId, userType);
      return saved;
    });
  }

  async removeGrant(
    folderId: string,
    principalId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    await this.requireAccess(folderId, userId, 'manager', userType);
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.delete(FolderAccessGrantEntity, {
        folderId,
        principalType: 'user',
        principalId,
      });
      if (!result.affected) {
        throw new NotFoundException('Grant not found');
      }
      await this.ensureStillManager(manager, folderId, userId, userType);
    });
  }

  async replaceGrants(
    folderId: string,
    entries: UpsertFolderGrantDto[],
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<FolderAccessGrantEntity[]> {
    await this.requireAccess(folderId, userId, 'manager', userType);
    const principalIds = entries.map((entry) => entry.principalId);
    if (new Set(principalIds).size !== principalIds.length) {
      throw new BadRequestException('Each user can only have one grant per folder');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(FolderAccessGrantEntity, { folderId });
      if (entries.length > 0) {
        await manager.insert(
          FolderAccessGrantEntity,
          entries.map((entry) => ({
            id: uuidv7(),
            folderId,
            principalType: 'user' as const,
            principalId: entry.principalId,
            accessLevel: entry.accessLevel,
            inheritChildren: entry.inheritChildren,
            grantedBy: userId,
          })),
        );
      }
      await this.ensureStillManager(manager, folderId, userId, userType);
    });
    const grants = await this.grantRepository.find({
      where: { folderId },
      order: { principalType: 'ASC', principalId: 'ASC' },
    });
    return (await this.actorEnrichment.enrich(grants as unknown as Array<Record<string, unknown>>, [
      { id: 'principalId', target: 'principalUser' },
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as FolderAccessGrantEntity[];
  }

  /** Direct grants of one user, limited to folders the requester manages. */
  async userGrants(
    targetUserId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<UserFolderGrant[]> {
    const grants = await this.grantRepository.find({
      where: { principalType: 'user', principalId: targetUserId },
    });
    if (grants.length === 0) {
      return [];
    }
    const levels = await this.accessService.accessLevels(userId, userType);
    const managedFolderIds = grants
      .map((grant) => grant.folderId)
      .filter((id) => levels.get(id) === 'manager');
    if (managedFolderIds.length === 0) {
      return [];
    }
    const folders = await this.folderRepository.find({
      where: { id: In(managedFolderIds), isActive: true },
    });
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const rows = grants.flatMap((grant) => {
      const folder = folderById.get(grant.folderId);
      return folder
        ? [
            {
              ...grant,
              folder: {
                id: folder.id,
                name: folder.name,
                pathText: folder.pathText,
                pathIds: folder.pathIds,
              },
            },
          ]
        : [];
    });
    rows.sort((a, b) =>
      a.folder.pathText.localeCompare(b.folder.pathText, 'vi', { numeric: true }),
    );
    return (await this.actorEnrichment.enrich(rows as unknown as Array<Record<string, unknown>>, [
      { id: 'principalId', target: 'principalUser' },
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as UserFolderGrant[];
  }

  private async ensureStillManager(
    manager: EntityManager,
    folderId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    const stillManager = await this.accessService.canAccess(
      folderId,
      userId,
      'manager',
      userType,
      manager,
    );
    if (!stillManager) {
      throw new ConflictException('You cannot remove your own manager access to this folder');
    }
  }

  private async requireActiveFolder(folderId: string): Promise<void> {
    const exists = await this.folderRepository.exists({ where: { id: folderId, isActive: true } });
    if (!exists) {
      throw new NotFoundException('Folder not found');
    }
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
