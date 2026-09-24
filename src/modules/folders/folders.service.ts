import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { UpsertFolderGrantDto } from './dto/upsert-folder-grant.dto';
import { FolderAccessLevel, FolderAccessService } from './folder-access.service';

export type FolderTreeItem = FolderEntity & { childCount: number; projectCount: number };

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
  ): Promise<FolderEntity> {
    return this.dataSource.transaction(async (manager) => {
      const parent = dto.parentId
        ? await manager.findOne(FolderEntity, { where: { id: dto.parentId, isActive: true } })
        : null;
      if (dto.parentId && !parent) {
        throw new NotFoundException('Parent folder not found');
      }
      if (parent) {
        const canManage = await this.accessService.canAccess(parent.id, userId, 'editor', userType);
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
    const ids = await this.accessService.accessibleFolderIds(userId, userType);
    if (ids.length === 0) {
      return [];
    }
    const folders = await this.folderRepository.find({
      where: { id: In(ids), isActive: true },
      order: { depth: 'ASC', sortOrder: 'ASC', name: 'ASC' },
    });
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
    }));
    return (await this.actorEnrichment.enrich(
      items as unknown as Array<Record<string, unknown>>,
      [{ id: 'createdBy', target: 'createdByUser' }],
    )) as unknown as FolderTreeItem[];
  }

  async update(
    folderId: string,
    dto: UpdateFolderDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<FolderEntity> {
    await this.requireAccess(folderId, userId, 'editor', userType);
    return this.dataSource.transaction(async (manager) => {
      const folder = await manager.findOne(FolderEntity, { where: { id: folderId, isActive: true } });
      if (!folder) {
        throw new NotFoundException('Folder not found');
      }
      const oldPathText = folder.pathText;
      const oldPathKey = folder.pathKey;
      if (dto.name && dto.name.trim() !== folder.name) {
        const name = dto.name.trim();
        const duplicate = await manager
          .createQueryBuilder(FolderEntity, 'folder')
          .where('LOWER(folder.name) = LOWER(:name)', { name })
          .andWhere('folder.id <> :folderId', { folderId })
          .andWhere(
            folder.parentId ? 'folder.parent_id = :parentId' : 'folder.parent_id IS NULL',
            folder.parentId ? { parentId: folder.parentId } : {},
          )
          .getOne();
        if (duplicate) {
          throw new ConflictException('A folder with this name already exists');
        }
        folder.name = name;
        folder.pathText = folder.parentId
          ? `${folder.pathText.split(' / ').slice(0, -1).join(' / ')} / ${folder.name}`
          : folder.name;
        folder.pathKey = folder.parentId
          ? `${folder.pathKey.split('/').slice(0, -1).join('/')}/${this.slugify(folder.name)}`
          : this.slugify(folder.name);
      }
      if (dto.sortOrder !== undefined) {
        folder.sortOrder = dto.sortOrder;
      }
      const saved = await manager.save(folder);

      if (saved.pathText !== oldPathText || saved.pathKey !== oldPathKey) {
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
          }
          await manager.save(descendants);
        }
      }
      return saved;
    });
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
  ): Promise<FolderAccessGrantEntity[]> {
    await this.requireAccess(folderId, userId, 'manager', userType);
    const grants = await this.grantRepository.find({
      where: { folderId },
      order: { principalType: 'ASC', principalId: 'ASC' },
    });
    return (await this.actorEnrichment.enrich(grants as unknown as Array<Record<string, unknown>>, [
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as FolderAccessGrantEntity[];
  }

  async replaceGrants(
    folderId: string,
    entries: UpsertFolderGrantDto[],
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<FolderAccessGrantEntity[]> {
    await this.requireAccess(folderId, userId, 'manager', userType);
    await this.grantRepository.delete({ folderId });
    await this.grantRepository.insert(
      entries.map((entry) => ({
        id: uuidv7(),
        folderId,
        principalType: 'user',
        principalId: entry.principalId,
        accessLevel: entry.accessLevel,
        inheritChildren: entry.inheritChildren,
        grantedBy: userId,
      })),
    );
    const grants = await this.grantRepository.find({
      where: { folderId },
      order: { principalType: 'ASC', principalId: 'ASC' },
    });
    return (await this.actorEnrichment.enrich(grants as unknown as Array<Record<string, unknown>>, [
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as FolderAccessGrantEntity[];
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
