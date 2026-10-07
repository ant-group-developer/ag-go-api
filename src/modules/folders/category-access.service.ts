import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { CategoryAccessGrantEntity } from '../../database/entities/category-access-grant.entity';
import { CategoryEntity } from '../../database/entities/category.entity';
import type { AccountUser } from '../account/account.types';
import { CategoryAccessUsersQueryDto } from './dto/category-access-users-query.dto';

/** Categories listed per user; the rest are counted, and loaded with the user's grants on demand. */
const CATEGORY_PREVIEW_LIMIT = 3;

type UserSummary =
  (Pick<AccountUser, 'id'> & { name?: unknown; email?: unknown; avatar?: unknown }) | null;

export type CategoryAccessUserSummary = {
  userId: string;
  user: UserSummary;
  categoryCount: number;
  lastUpdatedAt: Date;
  /** The first categories by name (at most `CATEGORY_PREVIEW_LIMIT`); see `categoryCount`. */
  categories: Array<{ id: string; name: string }>;
};

export type CategoryAccessUsersPage = {
  data: CategoryAccessUserSummary[];
  total: number;
  page: number;
  limit: number;
};

export type UserCategoryGrant = CategoryAccessGrantEntity & {
  category: { id: string; name: string; isActive: boolean };
  principalUser?: UserSummary;
  grantedByUser?: UserSummary;
};

/**
 * Category grants decide what a user sees on the "Projects" page. Managed by holders of
 * `go.category.access_manage`, on every category: categories have no owner to delegate to.
 */
@Injectable()
export class CategoryAccessService {
  constructor(
    @InjectRepository(CategoryAccessGrantEntity)
    private readonly grantRepository: Repository<CategoryAccessGrantEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  /** Users with at least one category grant. */
  async users(query: CategoryAccessUsersQueryDto): Promise<CategoryAccessUsersPage> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const grants = await this.grantRepository.find({ where: { principalType: 'user' } });
    if (grants.length === 0) {
      return { data: [], total: 0, page, limit };
    }
    const categoryById = await this.categoriesById(grants.map((grant) => grant.categoryId));

    const summaries = new Map<string, CategoryAccessUserSummary>();
    for (const grant of grants) {
      const category = categoryById.get(grant.categoryId);
      if (!category) {
        continue;
      }
      const summary = summaries.get(grant.principalId) ?? {
        userId: grant.principalId,
        user: null,
        categoryCount: 0,
        lastUpdatedAt: grant.updatedAt,
        categories: [],
      };
      summary.categoryCount += 1;
      if (grant.updatedAt > summary.lastUpdatedAt) {
        summary.lastUpdatedAt = grant.updatedAt;
      }
      summary.categories.push({ id: category.id, name: category.name });
      summaries.set(grant.principalId, summary);
    }

    let rows = (await this.actorEnrichment.enrich(
      [...summaries.values()] as unknown as Array<Record<string, unknown>>,
      [{ id: 'userId', target: 'user' }],
    )) as unknown as CategoryAccessUserSummary[];

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
        sortBy === 'categoryCount'
          ? a.categoryCount - b.categoryCount
          : sortBy === 'updatedAt'
            ? a.lastUpdatedAt.getTime() - b.lastUpdatedAt.getTime()
            : displayName(a).localeCompare(displayName(b), 'vi', { sensitivity: 'base' });
      return result * direction;
    });
    const pageRows = rows.slice((page - 1) * limit, page * limit);
    for (const row of pageRows) {
      row.categories = row.categories
        .sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }))
        .slice(0, CATEGORY_PREVIEW_LIMIT);
    }

    return {
      data: pageRows,
      total: rows.length,
      page,
      limit,
    };
  }

  /** Category grants of one user, inactive categories included so they can be removed. */
  async userGrants(targetUserId: string): Promise<UserCategoryGrant[]> {
    const grants = await this.grantRepository.find({
      where: { principalType: 'user', principalId: targetUserId },
    });
    if (grants.length === 0) {
      return [];
    }
    const categoryById = await this.categoriesById(grants.map((grant) => grant.categoryId));
    const rows = grants.flatMap((grant) => {
      const category = categoryById.get(grant.categoryId);
      return category
        ? [
            {
              ...grant,
              category: { id: category.id, name: category.name, isActive: category.isActive },
            },
          ]
        : [];
    });
    rows.sort((a, b) => a.category.name.localeCompare(b.category.name, 'vi', { numeric: true }));
    return (await this.actorEnrichment.enrich(rows as unknown as Array<Record<string, unknown>>, [
      { id: 'principalId', target: 'principalUser' },
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as UserCategoryGrant[];
  }

  /** User grants on one category, newest first. */
  async categoryGrants(categoryId: string): Promise<UserCategoryGrant[]> {
    const category = await this.categoryRepository.findOne({
      where: { id: categoryId },
      select: { id: true, name: true, isActive: true },
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    const grants = await this.grantRepository.find({
      where: { principalType: 'user', categoryId },
      order: { updatedAt: 'DESC' },
    });
    const rows = grants.map((grant) => ({
      ...grant,
      category: { id: category.id, name: category.name, isActive: category.isActive },
    }));
    return (await this.actorEnrichment.enrich(rows as unknown as Array<Record<string, unknown>>, [
      { id: 'principalId', target: 'principalUser' },
      { id: 'grantedBy', target: 'grantedByUser' },
    ])) as unknown as UserCategoryGrant[];
  }

  /** Grants the categories to the user; categories already granted are left as they are. */
  async addGrants(
    targetUserId: string,
    categoryIds: string[],
    requesterId: string,
  ): Promise<UserCategoryGrant[]> {
    const uniqueIds = [...new Set(categoryIds)];
    const activeCount = await this.categoryRepository.count({
      where: { id: In(uniqueIds), isActive: true },
    });
    if (activeCount !== uniqueIds.length) {
      throw new NotFoundException('One or more categories were not found');
    }
    await this.grantRepository
      .createQueryBuilder()
      .insert()
      .values(
        uniqueIds.map((categoryId) => ({
          id: uuidv7(),
          categoryId,
          principalType: 'user' as const,
          principalId: targetUserId,
          grantedBy: requesterId,
        })),
      )
      .orIgnore()
      .execute();
    return this.userGrants(targetUserId);
  }

  async removeGrant(targetUserId: string, categoryId: string): Promise<void> {
    const result = await this.grantRepository.delete({
      categoryId,
      principalType: 'user',
      principalId: targetUserId,
    });
    if (!result.affected) {
      throw new NotFoundException('Category grant not found');
    }
  }

  private async categoriesById(ids: string[]): Promise<Map<string, CategoryEntity>> {
    const categories = await this.categoryRepository.find({
      where: { id: In([...new Set(ids)]) },
      select: { id: true, name: true, isActive: true },
    });
    return new Map(categories.map((category) => [category.id, category]));
  }
}

function userText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function displayName(row: CategoryAccessUserSummary): string {
  return userText(row.user?.name) || userText(row.user?.email) || row.userId;
}
