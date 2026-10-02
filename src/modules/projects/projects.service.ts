import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService, type ActorUser } from '../../common/actor-enrichment.service';
import { isAdminUserType } from '../../common/auth/user-type';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { OutboxService } from '../../common/outbox.service';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { TagEntity } from '../../database/entities/tag.entity';
import { diffAuditSnapshots, type AuditValue } from '../audit/audit-changes';
import { AuditService } from '../audit/audit.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import {
  ASSET_STORAGE_PURGE_EVENT,
  deleteAssetsAndRefreshBatches,
  planProjectAssetCleanup,
} from './project-asset-cleanup';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(FolderEntity)
    private readonly folderRepository: Repository<FolderEntity>,
    @InjectRepository(CategoryEntity)
    private readonly categoryRepository: Repository<CategoryEntity>,
    @InjectRepository(CountryEntity)
    private readonly countryRepository: Repository<CountryEntity>,
    @InjectRepository(ProvinceEntity)
    private readonly provinceRepository: Repository<ProvinceEntity>,
    @InjectRepository(TagEntity)
    private readonly tagRepository: Repository<TagEntity>,
    private readonly folderAccessService: FolderAccessService,
    private readonly actorEnrichment: ActorEnrichmentService,
    private readonly auditService: AuditService,
    private readonly outboxService: OutboxService,
  ) {}

  async list(query: ListProjectsQueryDto, userId: string, userType?: 'ADMIN' | 'USER') {
    const folderIds = await this.folderAccessService.accessibleFolderIds(userId, userType);
    if (folderIds.length === 0) {
      return new ListResponseDto([], query.page, query.pageSize, 0);
    }

    const projectQuery = this.projectRepository
      .createQueryBuilder('project')
      .where('project.folderId IN (:...accessibleFolderIds)', { accessibleFolderIds: folderIds });

    // Only admins can list everyone's drafts; other users only see their own drafts.
    if (!isAdminUserType(userType)) {
      projectQuery.andWhere(
        "(project.evaluationStatus <> 'draft' OR project.ownerUserId = :currentUserId)",
        { currentUserId: userId },
      );
    }

    if (query.normalizedKeyword) {
      projectQuery.andWhere(
        "(LOWER(project.name) LIKE :keyword OR LOWER(COALESCE(project.description, '')) LIKE :keyword)",
        { keyword: `%${query.normalizedKeyword.toLocaleLowerCase('vi-VN')}%` },
      );
    }
    const filterFolderIds = [
      ...new Set([...(query.folderIds ?? []), ...(query.folderId ? [query.folderId] : [])]),
    ];
    if (filterFolderIds.length) {
      projectQuery.andWhere(
        `project.folderId IN (
          SELECT folder_closure.descendant_id
          FROM folder_closure
          WHERE folder_closure.ancestor_id IN (:...filterFolderIds)
        )`,
        { filterFolderIds },
      );
    }
    if (query.countryId) {
      projectQuery.andWhere('project.countryId = :countryId', { countryId: query.countryId });
    }
    if (query.provinceId) {
      projectQuery.andWhere('project.provinceId = :provinceId', { provinceId: query.provinceId });
    }
    const filterCategoryIds = [
      ...new Set([...(query.categoryIds ?? []), ...(query.categoryId ? [query.categoryId] : [])]),
    ];
    if (filterCategoryIds.length) {
      projectQuery.andWhere('project.categoryId IN (:...filterCategoryIds)', { filterCategoryIds });
    }
    if (query.mine) {
      projectQuery.andWhere('project.ownerUserId = :ownerUserId', { ownerUserId: userId });
    }
    if (query.ownerUserIds?.length) {
      projectQuery.andWhere('project.ownerUserId IN (:...ownerUserIds)', {
        ownerUserIds: query.ownerUserIds,
      });
    }
    if (query.evaluationStatuses?.length) {
      projectQuery.andWhere('project.evaluationStatus IN (:...evaluationStatuses)', {
        evaluationStatuses: query.evaluationStatuses,
      });
    }
    if (query.tagIds?.length) {
      projectQuery.andWhere(
        `EXISTS (
          SELECT 1
          FROM project_tags project_tag
          WHERE project_tag.project_id = project.id
            AND project_tag.tag_id IN (:...tagIds)
        )`,
        { tagIds: query.tagIds },
      );
    }

    const sortOrder = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    if (query.sortBy === 'folder') {
      // Sort by the folder's full path so subfolders stay grouped under their parent; natural
      // order so "Folder 9" comes before "Folder 10", as the folder tree and footage sort it.
      projectQuery
        .addSelect(
          '(SELECT folder.path_text FROM folders folder WHERE folder.id = project.folder_id) COLLATE natural_sort',
          'folder_path_sort',
        )
        .addSelect('project.name COLLATE natural_sort', 'name_sort')
        .orderBy('folder_path_sort', sortOrder)
        .addOrderBy('name_sort', sortOrder);
    } else if (query.sortBy === 'name') {
      // Natural order so "10. ..." follows "9. ..." instead of "1. ...".
      projectQuery
        .addSelect('project.name COLLATE natural_sort', 'name_sort')
        .orderBy('name_sort', sortOrder);
    } else {
      projectQuery.orderBy(`project.${query.sortBy ?? 'updatedAt'}`, sortOrder);
    }
    const [projects, total] = await projectQuery
      .addOrderBy('project.id', sortOrder)
      .skip(query.skip)
      .take(query.pageSize)
      .getManyAndCount();

    if (projects.length === 0) {
      return new ListResponseDto([], query.page, query.pageSize, total);
    }

    const projectIds = projects.map((project) => project.id);
    const folderRecords = await this.folderRepository.findBy({
      id: In([...new Set(projects.map((project) => project.folderId))]),
    });
    const countries = await this.countryRepository.findBy({
      id: In([
        ...new Set(projects.flatMap((project) => (project.countryId ? [project.countryId] : []))),
      ]),
    });
    const provinces = await this.provinceRepository.findBy({
      id: In([
        ...new Set(projects.flatMap((project) => (project.provinceId ? [project.provinceId] : []))),
      ]),
    });
    const categories = await this.categoryRepository.findBy({
      id: In([
        ...new Set(projects.flatMap((project) => (project.categoryId ? [project.categoryId] : []))),
      ]),
    });
    const tags = (await this.dataSource.query(
      `SELECT project_tag.project_id AS "projectId", tag.id, tag.name
       FROM project_tags project_tag
       INNER JOIN tags tag ON tag.id = project_tag.tag_id
       WHERE project_tag.project_id = ANY($1::uuid[])
       ORDER BY tag.normalized_name ASC`,
      [projectIds],
    )) as Array<{ projectId: string; id: string; name: string }>;
    const thumbnails = await this.resolveThumbnails(projects);
    const folderById = new Map(folderRecords.map((folder) => [folder.id, folder]));
    const countryById = new Map(countries.map((country) => [country.id, country]));
    const provinceById = new Map(provinces.map((province) => [province.id, province]));
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const tagsByProjectId = new Map<string, Array<{ id: string; name: string }>>();
    for (const tag of tags) {
      const projectTags = tagsByProjectId.get(tag.projectId) ?? [];
      projectTags.push({ id: tag.id, name: tag.name });
      tagsByProjectId.set(tag.projectId, projectTags);
    }

    const items = projects.map((project) => {
      const country = project.countryId ? countryById.get(project.countryId) : undefined;
      const province = project.provinceId ? provinceById.get(project.provinceId) : undefined;
      const category = project.categoryId ? categoryById.get(project.categoryId) : undefined;
      const folder = folderById.get(project.folderId);

      return Object.assign(project, {
        folderPath: folder?.pathText ?? '',
        countryName: country?.name ?? null,
        countryFlagUrl: country?.flagUrl ?? null,
        provinceName: province?.name ?? null,
        categoryName: category?.name ?? null,
        thumbnailAssetId: thumbnails.get(project.id)?.assetId ?? null,
        thumbnailSource: thumbnails.get(project.id)?.source ?? null,
        tags: (tagsByProjectId.get(project.id) ?? []).map((tag) => tag.name),
        tagIds: (tagsByProjectId.get(project.id) ?? []).map((tag) => tag.id),
      });
    });

    const enrichedItems = await this.actorEnrichment.enrich(
      items as unknown as Array<Record<string, unknown>>,
      [{ id: 'ownerUserId', target: 'ownerUser' }],
    );
    return new ListResponseDto(enrichedItems, query.page, query.pageSize, total);
  }

  /** Owners (authors) of the projects the user can list, with how many projects each owns. */
  async owners(
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<Array<{ id: string; projectCount: number; user: ActorUser | null }>> {
    const folderIds = await this.folderAccessService.accessibleFolderIds(userId, userType);
    if (folderIds.length === 0) {
      return [];
    }
    const query = this.projectRepository
      .createQueryBuilder('project')
      .select('project.ownerUserId', 'id')
      .addSelect('COUNT(*)', 'projectCount')
      .where('project.folderId IN (:...folderIds)', { folderIds })
      .groupBy('project.ownerUserId');
    // Same visibility as the list: other users' drafts only for admins.
    if (!isAdminUserType(userType)) {
      query.andWhere("(project.evaluationStatus <> 'draft' OR project.ownerUserId = :userId)", {
        userId,
      });
    }
    const rows = (await query.getRawMany<{ id: string; projectCount: string }>()).map((row) => ({
      id: row.id,
      projectCount: Number(row.projectCount),
    }));
    return (await this.actorEnrichment.enrich(rows, [{ id: 'id', target: 'user' }])) as Array<
      (typeof rows)[number] & { user: ActorUser | null }
    >;
  }

  async findOne(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.projectRepository.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    await this.requireFolderAccess(project.folderId, userId, 'viewer', userType);
    const [folder, country, province, category, tags, renderedBytes] = await Promise.all([
      this.folderRepository.findOne({ where: { id: project.folderId } }),
      project.countryId
        ? this.countryRepository.findOne({ where: { id: project.countryId } })
        : Promise.resolve(null),
      project.provinceId
        ? this.provinceRepository.findOne({ where: { id: project.provinceId } })
        : Promise.resolve(null),
      project.categoryId
        ? this.categoryRepository.findOne({ where: { id: project.categoryId } })
        : Promise.resolve(null),
      this.dataSource.query(
        `SELECT tag.id, tag.name
         FROM project_tags project_tag
         INNER JOIN tags tag ON tag.id = project_tag.tag_id
         WHERE project_tag.project_id = $1
         ORDER BY tag.normalized_name ASC`,
        [project.id],
      ) as Promise<Array<{ id: string; name: string }>>,
      this.sumRenderedBytes(project.id),
    ]);
    const thumbnail = (await this.resolveThumbnails([project])).get(project.id);
    const [enrichedProject] = await this.actorEnrichment.enrich(
      [
        Object.assign(project, {
          renderedBytes,
          folderPath: folder?.pathText ?? '',
          countryName: country?.name ?? null,
          countryFlagUrl: country?.flagUrl ?? null,
          provinceName: province?.name ?? null,
          categoryName: category?.name ?? null,
          thumbnailAssetId: thumbnail?.assetId ?? null,
          thumbnailSource: thumbnail?.source ?? null,
          tagIds: tags.map((tag) => tag.id),
          tags: tags.map((tag) => tag.name),
        }) as unknown as Record<string, unknown>,
      ],
      [{ id: 'ownerUserId', target: 'ownerUser' }],
    );
    return enrichedProject as unknown as ProjectEntity;
  }

  async create(dto: CreateProjectDto, userId: string, userType?: 'ADMIN' | 'USER') {
    await this.requireFolderAccess(dto.folderId, userId, 'editor', userType);
    await this.validateCatalogs(dto.countryId, dto.provinceId, dto.categoryId);
    const requestedTagIds = [...new Set(dto.tagIds ?? [])];
    if (requestedTagIds.length > 0) {
      const tags = await this.tagRepository.findBy({ id: In(requestedTagIds) });
      if (tags.length !== requestedTagIds.length) {
        throw new NotFoundException('One or more tags were not found');
      }
    }

    const created = await this.dataSource.transaction(async (manager) => {
      const tagIds = [
        ...new Set([
          ...requestedTagIds,
          ...(await this.upsertTagNames(manager, dto.tags ?? [], userId)),
        ]),
      ];
      const project = await manager.save(
        manager.create(ProjectEntity, {
          id: uuidv7(),
          ownerUserId: userId,
          folderId: dto.folderId,
          name: dto.name.trim(),
          description: dto.description?.trim() ?? null,
          categoryId: dto.categoryId ?? null,
          countryId: dto.countryId ?? null,
          provinceId: dto.provinceId ?? null,
          evaluationStatus: 'draft',
          mediaCount: 0,
          imageCount: 0,
          videoCount: 0,
          originalBytes: '0',
          renderedBytes: '0',
        }),
      );
      await manager.save(
        manager.create(ProjectEvaluationSummaryEntity, {
          projectId: project.id,
          totalMedia: 0,
          pendingCount: 0,
          approvedCount: 0,
          rejectedCount: 0,
          evaluationStatus: 'draft',
        }),
      );
      if (tagIds.length > 0) {
        await manager.query(
          'INSERT INTO project_tags (project_id, tag_id) SELECT $1, unnest($2::uuid[])',
          [project.id, tagIds],
        );
      }
      return project;
    });
    const folder = await this.folderRepository.findOne({ where: { id: created.folderId } });
    await this.auditService.record({
      projectId: created.id,
      actorUserId: userId,
      action: 'project_created',
      afterData: {
        name: created.name,
        folderId: created.folderId,
        folder: folder?.pathText ?? null,
      },
    });
    return created;
  }

  async update(id: string, dto: UpdateProjectDto, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.findOne(id, userId, userType);
    await this.requireFolderAccess(project.folderId, userId, 'editor', userType);
    const folderId = dto.folderId ?? project.folderId;
    if (folderId !== project.folderId) {
      await this.requireFolderAccess(folderId, userId, 'editor', userType);
    }

    const countryChanged = dto.countryId !== undefined && dto.countryId !== project.countryId;
    const countryId = dto.countryId === undefined ? project.countryId : dto.countryId;
    const provinceId =
      dto.provinceId === undefined ? (countryChanged ? null : project.provinceId) : dto.provinceId;
    const categoryId = dto.categoryId === undefined ? project.categoryId : dto.categoryId;
    await this.validateCatalogs(
      countryId ?? undefined,
      provinceId ?? undefined,
      categoryId ?? undefined,
    );

    const updatePayload = {
      folderId,
      name: dto.name?.trim() ?? project.name,
      description:
        dto.description === undefined ? project.description : dto.description?.trim() || null,
      categoryId,
      countryId,
      provinceId,
    };

    await this.dataSource.transaction(async (manager) => {
      await manager.update(ProjectEntity, id, updatePayload);
      if (dto.tags !== undefined) {
        const tagIds = await this.upsertTagNames(manager, dto.tags ?? [], userId);
        await manager.query('DELETE FROM project_tags WHERE project_id = $1', [project.id]);
        if (tagIds.length > 0) {
          await manager.query(
            'INSERT INTO project_tags (project_id, tag_id) SELECT $1, unnest($2::uuid[])',
            [project.id, tagIds],
          );
        }
      }
    });
    const updated = await this.findOne(id, userId, userType);
    const changes = diffAuditSnapshots(
      projectAuditSnapshot(project),
      projectAuditSnapshot(updated),
    );
    // Saving the form unchanged is not worth an entry.
    if (changes.length > 0) {
      await this.auditService.record({
        projectId: id,
        actorUserId: userId,
        action: 'project_updated',
        afterData: { changes },
      });
    }
    return updated;
  }

  async remove(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.findOne(id, userId, userType);
    await this.requireFolderAccess(project.folderId, userId, 'editor', userType);
    const storagePrefix = `projects/${id}/`;
    await this.dataSource.transaction(async (manager) => {
      // Planned before the delete, while this project's media rows still exist.
      const { removableAssetIds, keepPrefixes, extraPurgePrefixes } = await planProjectAssetCleanup(
        manager,
        id,
        storagePrefix,
      );

      await manager.delete(ProjectEntity, id);
      await deleteAssetsAndRefreshBatches(manager, removableAssetIds);
      // Their ZIP files live under the prefix too.
      await manager.query(
        `UPDATE download_jobs
         SET status = CASE WHEN status = 'completed' THEN 'expired' ELSE 'cancelled' END,
             updated_at = now()
         WHERE project_id = $1 AND status IN ('queued', 'processing', 'completed')`,
        [id],
      );
      if (extraPurgePrefixes.length > 0) {
        await manager.save(
          this.outboxService.create(manager, {
            eventType: ASSET_STORAGE_PURGE_EVENT,
            aggregateType: 'project',
            aggregateId: id,
            payload: { prefixes: extraPurgePrefixes },
          }),
        );
      }
      await manager.save(
        this.outboxService.create(manager, {
          eventType: 'project.storage.purge',
          aggregateType: 'project',
          aggregateId: id,
          payload: { prefix: storagePrefix, keepPrefixes },
        }),
      );
    });
    await this.auditService.record({
      projectId: id,
      actorUserId: userId,
      action: 'project_deleted',
      beforeData: {
        name: project.name,
        folderId: project.folderId,
        folder: (project as ProjectDetail).folderPath || null,
      },
    });
    return { success: true };
  }

  /**
   * Rendered storage of a project: sum of ready variants (thumbnail, preview, rendered sizes...)
   * of its distinct assets. Computed live because variants are produced asynchronously by the
   * media workers and `projects.rendered_bytes` is not maintained (same rule as statistics).
   */
  private async sumRenderedBytes(projectId: string): Promise<string> {
    const rows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(variant.file_size_bytes), 0)::text AS "renderedBytes"
       FROM asset_variants variant
       WHERE variant.status = 'ready'
         AND variant.asset_id IN (
           SELECT media.asset_id FROM project_media media WHERE media.project_id = $1
         )`,
      [projectId],
    )) as Array<{ renderedBytes: string }>;
    return rows[0]?.renderedBytes ?? '0';
  }

  /**
   * Project thumbnail: the media chosen by the user, otherwise the first media (images before
   * videos, by sort order) whose thumbnail variant is ready. Thumbnails carry no watermark.
   */
  private async resolveThumbnails(
    projects: Array<Pick<ProjectEntity, 'id' | 'thumbnailProjectMediaId'>>,
  ): Promise<Map<string, { assetId: string; source: 'manual' | 'auto' }>> {
    const thumbnails = new Map<string, { assetId: string; source: 'manual' | 'auto' }>();
    const manualMediaIds = projects.flatMap((project) =>
      project.thumbnailProjectMediaId ? [project.thumbnailProjectMediaId] : [],
    );
    if (manualMediaIds.length > 0) {
      const manualMedia = await this.dataSource
        .getRepository(ProjectMediaEntity)
        .findBy({ id: In(manualMediaIds) });
      for (const media of manualMedia) {
        thumbnails.set(media.projectId, { assetId: media.assetId, source: 'manual' });
      }
    }

    const missingProjectIds = projects
      .filter((project) => !thumbnails.has(project.id))
      .map((project) => project.id);
    if (missingProjectIds.length === 0) {
      return thumbnails;
    }
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT ON (media.project_id)
         media.project_id AS "projectId", media.asset_id AS "assetId"
       FROM project_media media
       INNER JOIN assets asset ON asset.id = media.asset_id
       INNER JOIN asset_variants variant
         ON variant.asset_id = media.asset_id
        AND variant.variant_code = 'thumbnail'
        AND variant.status = 'ready'
       WHERE media.project_id = ANY($1::uuid[])
       ORDER BY media.project_id, (asset.asset_type = 'image') DESC, media.sort_order ASC, media.id ASC`,
      [missingProjectIds],
    )) as Array<{ projectId: string; assetId: string }>;
    for (const row of rows) {
      thumbnails.set(row.projectId, { assetId: row.assetId, source: 'auto' });
    }
    return thumbnails;
  }

  private async validateCatalogs(countryId?: string, provinceId?: string, categoryId?: string) {
    if (
      categoryId &&
      !(await this.categoryRepository.exists({ where: { id: categoryId, isActive: true } }))
    ) {
      throw new NotFoundException('Category not found');
    }
    if (
      countryId &&
      !(await this.countryRepository.exists({ where: { id: countryId, isActive: true } }))
    ) {
      throw new NotFoundException('Country not found');
    }
    if (provinceId) {
      const province = await this.provinceRepository.findOne({
        where: { id: provinceId, isActive: true },
      });
      if (!province || (countryId && province.countryId !== countryId)) {
        throw new NotFoundException('Province does not belong to country');
      }
    }
  }

  private async upsertTagNames(
    manager: import('typeorm').EntityManager,
    names: string[],
    userId: string,
  ): Promise<string[]> {
    const uniqueNames = [
      ...new Map(
        names
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => [name.toLocaleLowerCase('vi-VN'), name]),
      ).values(),
    ];
    const tagIds: string[] = [];

    for (const name of uniqueNames) {
      const normalizedName = name.toLocaleLowerCase('vi-VN');
      const rows = (await manager.query(
        `INSERT INTO tags (id, name, normalized_name, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (normalized_name)
         DO UPDATE SET normalized_name = EXCLUDED.normalized_name
         RETURNING id`,
        [uuidv7(), name, normalizedName, userId],
      )) as Array<{ id: string }>;
      if (rows[0]) {
        tagIds.push(rows[0].id);
      }
    }

    return tagIds;
  }

  private async requireFolderAccess(
    folderId: string,
    userId: string,
    level: 'viewer' | 'editor',
    userType?: 'ADMIN' | 'USER',
  ) {
    const allowed = await this.folderAccessService.canAccess(folderId, userId, level, userType);
    if (!allowed) {
      throw new ForbiddenException('Insufficient folder permission');
    }
  }
}

/** Display fields `findOne` adds to the entity. */
type ProjectDetail = ProjectEntity & {
  folderPath?: string;
  categoryName?: string | null;
  countryName?: string | null;
  provinceName?: string | null;
  tags?: string[];
};

/** What a project update can change, as readable values (names, not ids) for the audit log. */
function projectAuditSnapshot(project: ProjectEntity): Record<string, AuditValue> {
  const detail = project as ProjectDetail;
  return {
    name: detail.name,
    description: detail.description,
    folder: detail.folderPath ?? null,
    category: detail.categoryName ?? null,
    country: detail.countryName ?? null,
    province: detail.provinceName ?? null,
    tags: detail.tags ?? [],
  };
}
