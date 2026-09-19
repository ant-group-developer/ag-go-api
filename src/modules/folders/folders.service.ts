import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { UpsertFolderGrantDto } from './dto/upsert-folder-grant.dto';
import { FolderAccessLevel, FolderAccessService } from './folder-access.service';

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
  ) {}

  async create(dto: CreateFolderDto, userId: string, groupIds: string[]): Promise<FolderEntity> {
    return this.dataSource.transaction(async (manager) => {
      const parent = dto.parentId
        ? await manager.findOne(FolderEntity, { where: { id: dto.parentId, isActive: true } })
        : null;
      if (dto.parentId && !parent) {
        throw new NotFoundException('Parent folder not found');
      }
      if (parent) {
        const canManage = await this.accessService.canAccess(parent.id, userId, groupIds, 'editor');
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

  async tree(userId: string, groupIds: string[]): Promise<FolderEntity[]> {
    const ids = await this.accessService.accessibleFolderIds(userId, groupIds);
    if (ids.length === 0) {
      return [];
    }
    return this.folderRepository.find({
      where: { id: In(ids), isActive: true },
      order: { depth: 'ASC', sortOrder: 'ASC', name: 'ASC' },
    });
  }

  async update(
    folderId: string,
    dto: UpdateFolderDto,
    userId: string,
    groupIds: string[],
  ): Promise<FolderEntity> {
    await this.requireAccess(folderId, userId, groupIds, 'editor');
    const folder = await this.folderRepository.findOne({ where: { id: folderId, isActive: true } });
    if (!folder) {
      throw new NotFoundException('Folder not found');
    }
    if (dto.name && dto.name.trim() !== folder.name) {
      folder.name = dto.name.trim();
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
    return this.folderRepository.save(folder);
  }

  async remove(folderId: string, userId: string, groupIds: string[]): Promise<void> {
    await this.requireAccess(folderId, userId, groupIds, 'manager');
    const children = await this.folderRepository.count({
      where: { parentId: folderId, isActive: true },
    });
    if (children > 0) {
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
    groupIds: string[],
  ): Promise<FolderAccessGrantEntity[]> {
    await this.requireAccess(folderId, userId, groupIds, 'manager');
    return this.grantRepository.find({
      where: { folderId },
      order: { principalType: 'ASC', principalId: 'ASC' },
    });
  }

  async replaceGrants(
    folderId: string,
    entries: UpsertFolderGrantDto[],
    userId: string,
    groupIds: string[],
  ): Promise<FolderAccessGrantEntity[]> {
    await this.requireAccess(folderId, userId, groupIds, 'manager');
    await this.grantRepository.delete({ folderId });
    await this.grantRepository.insert(
      entries.map((entry) => ({
        id: uuidv7(),
        folderId,
        principalType: entry.principalType,
        principalId: entry.principalId,
        accessLevel: entry.accessLevel,
        inheritChildren: entry.inheritChildren,
        grantedBy: userId,
      })),
    );
    return this.grantRepository.find({
      where: { folderId },
      order: { principalType: 'ASC', principalId: 'ASC' },
    });
  }

  private async requireAccess(
    folderId: string,
    userId: string,
    groupIds: string[],
    minimum: FolderAccessLevel,
  ): Promise<void> {
    const allowed = await this.accessService.canAccess(folderId, userId, groupIds, minimum);
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
