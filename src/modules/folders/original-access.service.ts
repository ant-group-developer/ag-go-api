import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService, type ActorUser } from '../../common/actor-enrichment.service';
import { isAdminUserType } from '../../common/auth/user-type';
import { CategoryEntity } from '../../database/entities/category.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { OriginalAccessBundleEntity } from '../../database/entities/original-access-bundle.entity';
import type { GrantRequester } from './access-grants.service';
import { AccessGrantUsersQueryDto } from './dto/access-grant-users-query.dto';
import { SaveOriginalAccessBundleDto } from './dto/save-original-access-bundle.dto';
import { FolderAccessService } from './folder-access.service';

/** Pairs out of the granter's reach reported at once. */
const INVALID_PAIRS_LIMIT = 20;

type FolderSummary = { id: string; name: string; pathText: string; isActive: boolean };
type CategorySummary = { id: string; name: string; isActive: boolean };

export type OriginalAccessBundleView = {
  id: string;
  principalId: string;
  grantedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The folders picked (their subfolders are covered too), by path. */
  folders: FolderSummary[];
  categories: CategorySummary[];
  /** Whether the requester may change or remove it: its granter, or an admin. */
  canEdit: boolean;
  principalUser?: ActorUser | null;
  grantedByUser?: ActorUser | null;
};

export type OriginalAccessUserSummary = {
  userId: string;
  user: ActorUser | null;
  bundleCount: number;
  /** The user's bundles listed (see `users`), oldest first. */
  bundles: OriginalAccessBundleView[];
  lastUpdatedAt: Date;
};

export type OriginalAccessUsersPage = {
  data: OriginalAccessUserSummary[];
  total: number;
  page: number;
  limit: number;
};

/** Folders and categories the "Projects" filters offer; null means every one. */
export type ProjectFilterScope = {
  folderIds: string[] | null;
  categoryIds: string[] | null;
};

/** What the requester may put in a bundle: null means anything (admins). */
export type OriginalAccessReach = {
  folderIds: string[] | null;
  categoryIds: string[] | null;
};

export type OriginalAccessPreview = {
  /** The folders kept: a folder whose parent is picked too adds nothing. */
  folderIds: string[];
  /** Folder × category pairs out of the requester's reach (the first ones). */
  invalidPairs: Array<{ folder: FolderSummary; category: CategorySummary }>;
  invalidCount: number;
};

/**
 * Bundles of originals (`original_access_bundles`): a user sees the originals of the evaluated
 * projects in one of a bundle's folders and categories. Anyone who may open the Permissions menu
 * grants bundles within their own reach (their bundles and inherited work grants); admins grant
 * anything. A bundle is checked when saved only and stays whatever happens to its granter.
 */
@Injectable()
export class OriginalAccessService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(OriginalAccessBundleEntity)
    private readonly bundleRepository: Repository<OriginalAccessBundleEntity>,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    private readonly actorEnrichment: ActorEnrichmentService,
    private readonly folderAccess: FolderAccessService,
  ) {}

  /**
   * Filters of the "Projects" page: everything with `go.project.read_all`, otherwise the folders
   * (subfolders included) and categories of the user's bundles and work grants.
   */
  async projectFilterScope(
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<ProjectFilterScope> {
    if (this.folderAccess.canReadAllProjects(userType)) {
      return { folderIds: null, categoryIds: null };
    }
    const folderRows = (await this.dataSource.query(
      `SELECT DISTINCT closure.descendant_id AS id
       FROM folder_closure closure
       WHERE closure.ancestor_id IN (
           SELECT link.folder_id FROM original_access_bundle_folders link
           JOIN original_access_bundles bundle ON bundle.id = link.bundle_id
           WHERE bundle.principal_type = 'user' AND bundle.principal_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM access_grants grant_row
           WHERE grant_row.principal_type = 'user' AND grant_row.principal_id = $1
             AND grant_row.folder_id = closure.ancestor_id
             AND (closure.depth = 0 OR grant_row.inherit_children)
         )`,
      [userId],
    )) as Array<{ id: string }>;
    const everyCategory = (await this.dataSource.query(
      `SELECT 1 FROM access_grants
       WHERE principal_type = 'user' AND principal_id = $1 AND category_id IS NULL LIMIT 1`,
      [userId],
    )) as unknown[];
    const categoryRows = everyCategory.length
      ? null
      : ((await this.dataSource.query(
          `SELECT link.category_id AS id FROM original_access_bundle_categories link
           JOIN original_access_bundles bundle ON bundle.id = link.bundle_id
           WHERE bundle.principal_type = 'user' AND bundle.principal_id = $1
           UNION
           SELECT category_id FROM access_grants
           WHERE principal_type = 'user' AND principal_id = $1 AND category_id IS NOT NULL`,
          [userId],
        )) as Array<{ id: string }>);
    return {
      folderIds: folderRows.map((row) => row.id),
      categoryIds: categoryRows?.map((row) => row.id) ?? null,
    };
  }

  /**
   * Users with bundles, each with the bundles listed: every one for admins, those the requester
   * granted for others.
   */
  async users(
    query: AccessGrantUsersQueryDto,
    requester: GrantRequester,
  ): Promise<OriginalAccessUsersPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const bundles = await this.bundleRepository.find({
      where: isAdminUserType(requester.userType)
        ? { principalType: 'user' }
        : { principalType: 'user', grantedBy: requester.userId },
    });
    const views = await this.view(
      bundles.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      requester,
    );

    const summaries = new Map<string, OriginalAccessUserSummary>();
    for (const bundle of views) {
      const summary = summaries.get(bundle.principalId) ?? {
        userId: bundle.principalId,
        user: null,
        bundleCount: 0,
        bundles: [],
        lastUpdatedAt: bundle.updatedAt,
      };
      summary.bundleCount += 1;
      summary.bundles.push(bundle);
      if (bundle.updatedAt > summary.lastUpdatedAt) {
        summary.lastUpdatedAt = bundle.updatedAt;
      }
      summaries.set(bundle.principalId, summary);
    }
    const flattened = [...summaries.values()];

    let rows = (await this.actorEnrichment.enrich(
      flattened as unknown as Array<Record<string, unknown>>,
      [{ id: 'userId', target: 'user' }],
    )) as unknown as OriginalAccessUserSummary[];
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
          ? a.bundleCount - b.bundleCount
          : sortBy === 'updatedAt'
            ? a.lastUpdatedAt.getTime() - b.lastUpdatedAt.getTime()
            : displayName(a).localeCompare(displayName(b), 'vi', { sensitivity: 'base' });
      return result * direction;
    });
    return { data: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit };
  }

  /** Every bundle of one user, those the requester may not change included (read-only). */
  async userBundles(
    principalId: string,
    requester: GrantRequester,
  ): Promise<OriginalAccessBundleView[]> {
    const bundles = await this.bundleRepository.find({
      where: { principalType: 'user', principalId },
      order: { createdAt: 'ASC' },
    });
    return this.view(bundles, requester);
  }

  /** Bundles holding one category, for the Categories page. */
  async categoryBundles(
    categoryId: string,
    requester: GrantRequester,
  ): Promise<OriginalAccessBundleView[]> {
    if (!(await this.categoryRepository.exists({ where: { id: categoryId } }))) {
      throw new NotFoundException('Category not found');
    }
    const bundles = await this.bundleRepository
      .createQueryBuilder('bundle')
      .where(
        `EXISTS (SELECT 1 FROM original_access_bundle_categories link
                 WHERE link.bundle_id = bundle.id AND link.category_id = :categoryId)`,
        { categoryId },
      )
      .orderBy('bundle.updated_at', 'DESC')
      .getMany();
    return this.view(bundles, requester);
  }

  /**
   * What the requester may put in a bundle: folders (with their subfolders) and categories of
   * their own bundles and inherited work grants. Pairs are still checked one by one (`preview`).
   */
  async reach(requester: GrantRequester): Promise<OriginalAccessReach> {
    if (isAdminUserType(requester.userType)) {
      return { folderIds: null, categoryIds: null };
    }
    const userId = requester.userId;
    const folderRows = (await this.dataSource.query(
      `SELECT DISTINCT closure.descendant_id AS id
       FROM folder_closure closure
       WHERE closure.ancestor_id IN (
         SELECT link.folder_id FROM original_access_bundle_folders link
         JOIN original_access_bundles bundle ON bundle.id = link.bundle_id
         WHERE bundle.principal_type = 'user' AND bundle.principal_id = $1
         UNION
         SELECT grant_row.folder_id FROM access_grants grant_row
         WHERE grant_row.principal_type = 'user' AND grant_row.principal_id = $1
           AND grant_row.inherit_children
       )`,
      [userId],
    )) as Array<{ id: string }>;
    const everyCategory = (await this.dataSource.query(
      `SELECT 1 FROM access_grants
       WHERE principal_type = 'user' AND principal_id = $1 AND inherit_children
         AND category_id IS NULL
       LIMIT 1`,
      [userId],
    )) as unknown[];
    const categoryRows = everyCategory.length
      ? ((await this.dataSource.query(`SELECT id FROM categories WHERE is_active`)) as Array<{
          id: string;
        }>)
      : ((await this.dataSource.query(
          `SELECT link.category_id AS id FROM original_access_bundle_categories link
           JOIN original_access_bundles bundle ON bundle.id = link.bundle_id
           WHERE bundle.principal_type = 'user' AND bundle.principal_id = $1
           UNION
           SELECT category_id FROM access_grants
           WHERE principal_type = 'user' AND principal_id = $1 AND inherit_children
             AND category_id IS NOT NULL`,
          [userId],
        )) as Array<{ id: string }>);
    return {
      folderIds: folderRows.map((row) => row.id),
      categoryIds: categoryRows.map((row) => row.id),
    };
  }

  /** The folders a bundle keeps and the pairs out of the requester's reach. */
  async preview(
    dto: Pick<SaveOriginalAccessBundleDto, 'folderIds' | 'categoryIds'>,
    requester: GrantRequester,
  ): Promise<OriginalAccessPreview> {
    const folderIds = await this.topFolders(this.dataSource.manager, unique(dto.folderIds));
    const categoryIds = unique(dto.categoryIds);
    if (isAdminUserType(requester.userType) || !folderIds.length || !categoryIds.length) {
      return { folderIds, invalidPairs: [], invalidCount: 0 };
    }
    const pairs = await this.pairsOutOfReach(
      this.dataSource.manager,
      requester.userId,
      folderIds,
      categoryIds,
    );
    const [folders, categories] = await Promise.all([
      this.folderRepository.find({
        where: { id: In([...new Set(pairs.map((pair) => pair.folderId))]) },
        select: { id: true, name: true, pathText: true, isActive: true },
      }),
      this.categoryRepository.find({
        where: { id: In([...new Set(pairs.map((pair) => pair.categoryId))]) },
        select: { id: true, name: true, isActive: true },
      }),
    ]);
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    return {
      folderIds,
      invalidCount: pairs.length,
      invalidPairs: pairs.slice(0, INVALID_PAIRS_LIMIT).flatMap((pair) => {
        const folder = folderById.get(pair.folderId);
        const category = categoryById.get(pair.categoryId);
        return folder && category ? [{ folder: folderSummary(folder), category }] : [];
      }),
    };
  }

  async create(
    dto: SaveOriginalAccessBundleDto,
    requester: GrantRequester,
  ): Promise<OriginalAccessBundleView> {
    if (!dto.principalId) {
      throw new BadRequestException('principalId is required');
    }
    const principalId = dto.principalId;
    const id = await this.dataSource.transaction(async (manager) => {
      const { folderIds, categoryIds } = await this.validate(manager, dto, requester);
      const bundleId = uuidv7();
      await manager.insert(OriginalAccessBundleEntity, {
        id: bundleId,
        principalType: 'user',
        principalId,
        grantedBy: requester.userId,
      });
      await this.writeLinks(manager, bundleId, folderIds, categoryIds);
      return bundleId;
    });
    return this.viewOne(id, requester);
  }

  async update(
    id: string,
    dto: SaveOriginalAccessBundleDto,
    requester: GrantRequester,
  ): Promise<OriginalAccessBundleView> {
    await this.findEditable(id, requester);
    await this.dataSource.transaction(async (manager) => {
      const { folderIds, categoryIds } = await this.validate(manager, dto, requester);
      await manager.query(`DELETE FROM original_access_bundle_folders WHERE bundle_id = $1`, [id]);
      await manager.query(`DELETE FROM original_access_bundle_categories WHERE bundle_id = $1`, [
        id,
      ]);
      await this.writeLinks(manager, id, folderIds, categoryIds);
      await manager.update(OriginalAccessBundleEntity, id, { updatedAt: new Date() });
    });
    return this.viewOne(id, requester);
  }

  async remove(id: string, requester: GrantRequester): Promise<void> {
    await this.findEditable(id, requester);
    await this.bundleRepository.delete({ id });
  }

  private async findEditable(
    id: string,
    requester: GrantRequester,
  ): Promise<OriginalAccessBundleEntity> {
    const bundle = await this.bundleRepository.findOne({ where: { id } });
    if (!bundle) {
      throw new NotFoundException('Bundle not found');
    }
    if (!canEdit(bundle, requester)) {
      throw new ForbiddenException('Only its granter or an admin can change this bundle');
    }
    return bundle;
  }

  /** Both lists filled with active rows, every pair within the requester's reach. */
  private async validate(
    manager: EntityManager,
    dto: Pick<SaveOriginalAccessBundleDto, 'folderIds' | 'categoryIds'>,
    requester: GrantRequester,
  ): Promise<{ folderIds: string[]; categoryIds: string[] }> {
    const pickedFolderIds = unique(dto.folderIds);
    const categoryIds = unique(dto.categoryIds);
    if (!pickedFolderIds.length || !categoryIds.length) {
      throw new BadRequestException('Pick at least one folder and one category');
    }
    const [activeFolders, activeCategories] = await Promise.all([
      manager.count(FolderEntity, { where: { id: In(pickedFolderIds), isActive: true } }),
      manager.count(CategoryEntity, { where: { id: In(categoryIds), isActive: true } }),
    ]);
    if (activeFolders !== pickedFolderIds.length) {
      throw new NotFoundException('One or more folders were not found');
    }
    if (activeCategories !== categoryIds.length) {
      throw new NotFoundException('One or more categories were not found');
    }
    const folderIds = await this.topFolders(manager, pickedFolderIds);
    if (!isAdminUserType(requester.userType)) {
      const outOfReach = await this.pairsOutOfReach(
        manager,
        requester.userId,
        folderIds,
        categoryIds,
      );
      if (outOfReach.length) {
        throw new BadRequestException(
          `${outOfReach.length} folder × category pair(s) are out of your reach`,
        );
      }
    }
    return { folderIds, categoryIds };
  }

  /** Drops the folders whose ancestor is picked too: it already covers them. */
  private async topFolders(manager: EntityManager, folderIds: string[]): Promise<string[]> {
    if (folderIds.length < 2) {
      return folderIds;
    }
    const covered = (await manager.query(
      `SELECT DISTINCT descendant_id AS id FROM folder_closure
       WHERE ancestor_id = ANY($1::uuid[]) AND descendant_id = ANY($1::uuid[]) AND depth > 0`,
      [folderIds],
    )) as Array<{ id: string }>;
    const coveredIds = new Set(covered.map((row) => row.id));
    return folderIds.filter((id) => !coveredIds.has(id));
  }

  /**
   * Picked folder × category pairs the user may not hand on: neither one of their bundles nor an
   * inherited work grant covers the folder (from it or an ancestor) in that category.
   */
  private async pairsOutOfReach(
    manager: EntityManager,
    userId: string,
    folderIds: string[],
    categoryIds: string[],
  ): Promise<Array<{ folderId: string; categoryId: string }>> {
    return (await manager.query(
      `SELECT picked_folder.id AS "folderId", picked_category.id AS "categoryId"
       FROM unnest($1::uuid[]) AS picked_folder(id)
       CROSS JOIN unnest($2::uuid[]) AS picked_category(id)
       WHERE NOT EXISTS (
           SELECT 1 FROM original_access_bundles bundle
           JOIN original_access_bundle_folders bundle_folder ON bundle_folder.bundle_id = bundle.id
           JOIN folder_closure closure
             ON closure.ancestor_id = bundle_folder.folder_id
            AND closure.descendant_id = picked_folder.id
           JOIN original_access_bundle_categories bundle_category
             ON bundle_category.bundle_id = bundle.id
            AND bundle_category.category_id = picked_category.id
           WHERE bundle.principal_type = 'user' AND bundle.principal_id = $3
         )
         AND NOT EXISTS (
           SELECT 1 FROM access_grants grant_row
           JOIN folder_closure closure
             ON closure.ancestor_id = grant_row.folder_id
            AND closure.descendant_id = picked_folder.id
           WHERE grant_row.principal_type = 'user' AND grant_row.principal_id = $3
             AND grant_row.inherit_children
             AND (grant_row.category_id IS NULL OR grant_row.category_id = picked_category.id)
         )`,
      [folderIds, categoryIds, userId],
    )) as Array<{ folderId: string; categoryId: string }>;
  }

  private async writeLinks(
    manager: EntityManager,
    bundleId: string,
    folderIds: string[],
    categoryIds: string[],
  ): Promise<void> {
    await manager.query(
      `INSERT INTO original_access_bundle_folders (bundle_id, folder_id)
       SELECT $1, unnest($2::uuid[])`,
      [bundleId, folderIds],
    );
    await manager.query(
      `INSERT INTO original_access_bundle_categories (bundle_id, category_id)
       SELECT $1, unnest($2::uuid[])`,
      [bundleId, categoryIds],
    );
  }

  private async viewOne(id: string, requester: GrantRequester): Promise<OriginalAccessBundleView> {
    const bundle = await this.bundleRepository.findOneOrFail({ where: { id } });
    const [view] = await this.view([bundle], requester);
    return view;
  }

  /** Adds folders, categories, `canEdit` and (with `withActors`) the users involved. */
  private async view(
    bundles: OriginalAccessBundleEntity[],
    requester: GrantRequester,
    withActors = true,
  ): Promise<OriginalAccessBundleView[]> {
    if (bundles.length === 0) {
      return [];
    }
    const ids = bundles.map((bundle) => bundle.id);
    const [folderRows, categoryRows] = await Promise.all([
      this.dataSource.query(
        `SELECT link.bundle_id AS "bundleId", folder.id, folder.name,
                folder.path_text AS "pathText", folder.is_active AS "isActive"
         FROM original_access_bundle_folders link
         JOIN folders folder ON folder.id = link.folder_id
         WHERE link.bundle_id = ANY($1::uuid[])
         ORDER BY folder.path_text COLLATE natural_sort`,
        [ids],
      ) as Promise<Array<FolderSummary & { bundleId: string }>>,
      this.dataSource.query(
        `SELECT link.bundle_id AS "bundleId", category.id, category.name,
                category.is_active AS "isActive"
         FROM original_access_bundle_categories link
         JOIN categories category ON category.id = link.category_id
         WHERE link.bundle_id = ANY($1::uuid[])
         ORDER BY category.name COLLATE natural_sort`,
        [ids],
      ) as Promise<Array<CategorySummary & { bundleId: string }>>,
    ]);
    const views: OriginalAccessBundleView[] = bundles.map((bundle) => ({
      id: bundle.id,
      principalId: bundle.principalId,
      grantedBy: bundle.grantedBy,
      createdAt: bundle.createdAt,
      updatedAt: bundle.updatedAt,
      folders: folderRows
        .filter((row) => row.bundleId === bundle.id)
        .map((row) => ({
          id: row.id,
          name: row.name,
          pathText: row.pathText,
          isActive: row.isActive,
        })),
      categories: categoryRows
        .filter((row) => row.bundleId === bundle.id)
        .map((row) => ({ id: row.id, name: row.name, isActive: row.isActive })),
      canEdit: canEdit(bundle, requester),
    }));
    if (!withActors) {
      return views;
    }
    return (await this.actorEnrichment.enrich(views as unknown as Array<Record<string, unknown>>, [
      { id: 'principalId', target: 'principalUser' },
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as OriginalAccessBundleView[];
  }
}

function canEdit(bundle: OriginalAccessBundleEntity, requester: GrantRequester): boolean {
  return isAdminUserType(requester.userType) || bundle.grantedBy === requester.userId;
}

function unique(ids: string[] | undefined): string[] {
  return [...new Set(ids ?? [])];
}

function folderSummary(folder: FolderEntity): FolderSummary {
  return { id: folder.id, name: folder.name, pathText: folder.pathText, isActive: folder.isActive };
}

function userText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function displayName(row: OriginalAccessUserSummary): string {
  return userText(row.user?.name) || userText(row.user?.email) || row.userId;
}
