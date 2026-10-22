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
import { ActorEnrichmentService, type ActorUser } from '../../common/actor-enrichment.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { isAdminUserType } from '../../common/auth/user-type';
import { AccessGrantEntity, type AccessLevel } from '../../database/entities/access-grant.entity';
import { CategoryEntity } from '../../database/entities/category.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { AccessGrantUsersQueryDto } from './dto/access-grant-users-query.dto';
import { CreateAccessGrantsDto } from './dto/create-access-grants.dto';
import { UpdateAccessGrantDto } from './dto/update-access-grant.dto';
import { accessLevelRank, FolderAccessService, maxAccessLevel } from './folder-access.service';

/** Grants listed per user in the overview; the rest are counted, and loaded on demand. */
const GRANT_PREVIEW_LIMIT = 3;

/** Who is asking: work grants are managed per folder, by its managers. */
export type GrantRequester = {
  userId: string;
  userType?: 'ADMIN' | 'USER';
  permissions?: string[];
};

export type AccessGrantView = AccessGrantEntity & {
  /** Null only if the folder row is gone. */
  folder: {
    id: string;
    name: string;
    pathText: string;
    pathIds: string[];
    isActive: boolean;
  } | null;
  /** Null: every category. */
  category: { id: string; name: string; isActive: boolean } | null;
  principalUser?: ActorUser | null;
  grantedByUser?: ActorUser | null;
};

export type FolderGrantsResult = {
  direct: AccessGrantView[];
  /** Inherited from ancestors, nearest first. */
  inherited: AccessGrantView[];
};

export type AccessGrantUserSummary = {
  userId: string;
  user: ActorUser | null;
  grantCount: number;
  highestLevel: AccessLevel;
  lastUpdatedAt: Date;
  /** The first grants by folder path (at most `GRANT_PREVIEW_LIMIT`); see `grantCount`. */
  grants: AccessGrantView[];
};

export type AccessGrantUsersPage = {
  data: AccessGrantUserSummary[];
  total: number;
  page: number;
  limit: number;
};

/**
 * Managing the work grants (`access_grants`): those on a folder by its managers (with
 * `go.folder.manage`), every one by admins. Originals are granted in bundles, see
 * `OriginalAccessService`.
 */
@Injectable()
export class AccessGrantsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AccessGrantEntity)
    private readonly grantRepository: Repository<AccessGrantEntity>,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(FolderClosureEntity)
    private readonly closureRepository: Repository<FolderClosureEntity>,
    private readonly accessService: FolderAccessService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  /** Users with at least one grant the requester manages. */
  async users(
    query: AccessGrantUsersQueryDto,
    requester: GrantRequester,
  ): Promise<AccessGrantUsersPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const grants = await this.view(await this.manageableGrants(requester), false);

    const summaries = new Map<string, AccessGrantUserSummary>();
    for (const grant of grants) {
      const summary = summaries.get(grant.principalId) ?? {
        userId: grant.principalId,
        user: null,
        grantCount: 0,
        highestLevel: grant.accessLevel,
        lastUpdatedAt: grant.updatedAt,
        grants: [],
      };
      summary.grantCount += 1;
      summary.highestLevel = maxAccessLevel(summary.highestLevel, grant.accessLevel);
      if (grant.updatedAt > summary.lastUpdatedAt) {
        summary.lastUpdatedAt = grant.updatedAt;
      }
      summary.grants.push(grant);
      summaries.set(grant.principalId, summary);
    }

    let rows = (await this.actorEnrichment.enrich(
      [...summaries.values()] as unknown as Array<Record<string, unknown>>,
      [{ id: 'userId', target: 'user' }],
    )) as unknown as AccessGrantUserSummary[];

    const keyword = query.keyword?.trim().toLocaleLowerCase('vi-VN');
    if (keyword) {
      rows = rows.filter((row) =>
        [row.userId, userText(row.user?.name), userText(row.user?.email)].some((value) =>
          value.toLocaleLowerCase('vi-VN').includes(keyword),
        ),
      );
    }

    const direction = query.sortOrder === 'desc' ? -1 : 1;
    const sortBy = query.sortBy ?? 'user';
    rows.sort((a, b) => {
      const result =
        sortBy === 'grantCount'
          ? a.grantCount - b.grantCount
          : sortBy === 'highestLevel'
            ? accessLevelRank(a.highestLevel) - accessLevelRank(b.highestLevel)
            : sortBy === 'updatedAt'
              ? a.lastUpdatedAt.getTime() - b.lastUpdatedAt.getTime()
              : displayName(a).localeCompare(displayName(b), 'vi', { sensitivity: 'base' });
      return result * direction;
    });
    const pageRows = rows.slice((page - 1) * limit, page * limit);
    for (const row of pageRows) {
      row.grants = row.grants.sort(compareGrants).slice(0, GRANT_PREVIEW_LIMIT);
    }
    return { data: pageRows, total: rows.length, page, limit };
  }

  /** Grants of one user that the requester manages, inactive folders and categories included. */
  async userGrants(targetUserId: string, requester: GrantRequester): Promise<AccessGrantView[]> {
    const grants = await this.manageableGrants(requester, targetUserId);
    return (await this.view(grants)).sort(compareGrants);
  }

  /** Grants on a folder and those it inherits; for its managers. */
  async folderGrants(folderId: string, requester: GrantRequester): Promise<FolderGrantsResult> {
    await this.requireFolderManager(folderId, requester);
    const ancestors = await this.closureRepository.find({ where: { descendantId: folderId } });
    const depthByFolder = new Map(ancestors.map((entry) => [entry.ancestorId, entry.depth]));
    const grants = await this.grantRepository.find({
      where: { folderId: In([...depthByFolder.keys()]) },
      order: { createdAt: 'ASC' },
    });
    const views = await this.view(
      grants.filter((grant) => depthByFolder.get(grant.folderId) === 0 || grant.inheritChildren),
    );
    return {
      direct: views.filter((grant) => grant.folderId === folderId),
      inherited: views
        .filter((grant) => grant.folderId !== folderId)
        .sort((a, b) => depthByFolder.get(a.folderId)! - depthByFolder.get(b.folderId)!),
    };
  }

  /** Grants limited to one category, on any folder, that the requester manages. */
  async categoryGrants(categoryId: string, requester: GrantRequester): Promise<AccessGrantView[]> {
    if (!(await this.categoryRepository.exists({ where: { id: categoryId } }))) {
      throw new NotFoundException('Category not found');
    }
    const grants = (await this.manageableGrants(requester)).filter(
      (grant) => grant.categoryId === categoryId,
    );
    return (await this.view(grants)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /**
   * Grants one user a level on a folder for each category (or every category). A grant already
   * on the same folder and category takes the new level.
   */
  async create(dto: CreateAccessGrantsDto, requester: GrantRequester): Promise<AccessGrantView[]> {
    const folderId = dto.folderId;
    const categoryIds = [...new Set(dto.categoryIds ?? [])];
    if (dto.accessLevel === 'manager' && categoryIds.length > 0) {
      throw new BadRequestException('Manager access covers every category');
    }
    await this.requireCanManage(folderId, requester);
    if (!(await this.folderRepository.exists({ where: { id: folderId, isActive: true } }))) {
      throw new NotFoundException('Folder not found');
    }
    if (categoryIds.length > 0) {
      const activeCount = await this.categoryRepository.count({
        where: { id: In(categoryIds), isActive: true },
      });
      if (activeCount !== categoryIds.length) {
        throw new NotFoundException('One or more categories were not found');
      }
    }

    const ids = await this.dataSource.transaction(async (manager) => {
      const saved: string[] = [];
      for (const categoryId of categoryIds.length ? categoryIds : [null]) {
        const rows = (await manager.query(
          `INSERT INTO access_grants (
             id, principal_type, principal_id, folder_id, category_id, access_level,
             inherit_children, granted_by
           )
           VALUES ($1, 'user', $2, $3, $4, $5, $6, $7)
           ON CONFLICT (
             principal_type, principal_id,
             COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid),
             COALESCE(category_id, '00000000-0000-0000-0000-000000000000'::uuid)
           )
           DO UPDATE SET access_level = EXCLUDED.access_level,
                         inherit_children = EXCLUDED.inherit_children,
                         granted_by = EXCLUDED.granted_by,
                         updated_at = now()
           RETURNING id`,
          [
            uuidv7(),
            dto.principalId,
            folderId,
            categoryId,
            dto.accessLevel,
            dto.inheritChildren ?? true,
            requester.userId,
          ],
        )) as Array<{ id: string }>;
        saved.push(rows[0].id);
      }
      await this.ensureStillManager(manager, folderId, dto.principalId, requester);
      return saved;
    });
    return this.view(await this.grantRepository.find({ where: { id: In(ids) } }));
  }

  async update(
    id: string,
    dto: UpdateAccessGrantDto,
    requester: GrantRequester,
  ): Promise<AccessGrantView> {
    const grant = await this.findManageable(id, requester);
    const accessLevel = dto.accessLevel ?? grant.accessLevel;
    if (accessLevel === 'manager' && grant.categoryId) {
      throw new BadRequestException('Manager access covers every category');
    }
    await this.dataSource.transaction(async (manager) => {
      grant.accessLevel = accessLevel;
      grant.inheritChildren = dto.inheritChildren ?? grant.inheritChildren;
      grant.grantedBy = requester.userId;
      await manager.save(grant);
      await this.ensureStillManager(manager, grant.folderId, grant.principalId, requester);
    });
    const [view] = await this.view([grant]);
    return view;
  }

  async remove(id: string, requester: GrantRequester): Promise<void> {
    const grant = await this.findManageable(id, requester);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(AccessGrantEntity, { id: grant.id });
      await this.ensureStillManager(manager, grant.folderId, grant.principalId, requester);
    });
  }

  private async findManageable(id: string, requester: GrantRequester): Promise<AccessGrantEntity> {
    const grant = await this.grantRepository.findOne({ where: { id } });
    if (!grant) {
      throw new NotFoundException('Grant not found');
    }
    await this.requireCanManage(grant.folderId, requester);
    return grant;
  }

  /** Grants the requester may manage, optionally of one user only. */
  private async manageableGrants(
    requester: GrantRequester,
    principalId?: string,
  ): Promise<AccessGrantEntity[]> {
    const where = principalId ? { principalType: 'user' as const, principalId } : {};
    if (isAdminUserType(requester.userType)) {
      return this.grantRepository.find({ where });
    }
    const managedFolderIds = (requester.permissions ?? []).includes(GO_PERMISSIONS.FOLDER_MANAGE)
      ? await this.accessService.managedFolderIds(requester.userId, requester.userType)
      : [];
    if (managedFolderIds.length === 0) {
      return [];
    }
    return this.grantRepository
      .createQueryBuilder('grant')
      .where(principalId ? 'grant.principal_id = :principalId' : 'TRUE', { principalId })
      .andWhere('grant.folder_id IN (:...managedFolderIds)', { managedFolderIds })
      .getMany();
  }

  private async requireCanManage(folderId: string, requester: GrantRequester) {
    if (isAdminUserType(requester.userType)) {
      return;
    }
    if (!(requester.permissions ?? []).includes(GO_PERMISSIONS.FOLDER_MANAGE)) {
      throw new ForbiddenException('Folder grants need folder management');
    }
    await this.requireFolderManager(folderId, requester);
  }

  private async requireFolderManager(folderId: string, requester: GrantRequester) {
    if (
      !(await this.accessService.canAccess(
        folderId,
        requester.userId,
        'manager',
        requester.userType,
      ))
    ) {
      throw new ForbiddenException('Insufficient folder permission');
    }
  }

  /** A folder manager changing their own grants must not lose manager access to the folder. */
  private async ensureStillManager(
    manager: EntityManager,
    folderId: string,
    principalId: string,
    requester: GrantRequester,
  ): Promise<void> {
    if (principalId !== requester.userId || isAdminUserType(requester.userType)) {
      return;
    }
    const stillManager = await this.accessService.canAccess(
      folderId,
      requester.userId,
      'manager',
      requester.userType,
      manager,
    );
    if (!stillManager) {
      throw new ConflictException('You cannot remove your own manager access to this folder');
    }
  }

  /** Adds folder, category and (with `withActors`) the users involved. */
  private async view(grants: AccessGrantEntity[], withActors = true): Promise<AccessGrantView[]> {
    if (grants.length === 0) {
      return [];
    }
    const folderIds = [...new Set(grants.map((grant) => grant.folderId))];
    const categoryIds = [...new Set(grants.flatMap((grant) => grant.categoryId ?? []))];
    const [folders, categories] = await Promise.all([
      folderIds.length
        ? this.folderRepository.find({
            where: { id: In(folderIds) },
            select: { id: true, name: true, pathText: true, pathIds: true, isActive: true },
          })
        : [],
      categoryIds.length
        ? this.categoryRepository.find({
            where: { id: In(categoryIds) },
            select: { id: true, name: true, isActive: true },
          })
        : [],
    ]);
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const rows: AccessGrantView[] = grants.map((grant) => {
      const folder = folderById.get(grant.folderId);
      const category = grant.categoryId ? categoryById.get(grant.categoryId) : undefined;
      return {
        ...grant,
        folder: folder
          ? {
              id: folder.id,
              name: folder.name,
              pathText: folder.pathText,
              pathIds: folder.pathIds,
              isActive: folder.isActive,
            }
          : null,
        category: category
          ? { id: category.id, name: category.name, isActive: category.isActive }
          : null,
      };
    });
    if (!withActors) {
      return rows;
    }
    return (await this.actorEnrichment.enrich(rows as unknown as Array<Record<string, unknown>>, [
      { id: 'principalId', target: 'principalUser' },
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as AccessGrantView[];
  }
}

/** By folder path, then category name (every category first). */
function compareGrants(a: AccessGrantView, b: AccessGrantView): number {
  const folderA = a.folder?.pathText ?? '';
  const folderB = b.folder?.pathText ?? '';
  return (
    folderA.localeCompare(folderB, 'vi', { numeric: true }) ||
    (a.category?.name ?? '').localeCompare(b.category?.name ?? '', 'vi', { numeric: true })
  );
}

function userText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function displayName(row: AccessGrantUserSummary): string {
  return userText(row.user?.name) || userText(row.user?.email) || row.userId;
}
