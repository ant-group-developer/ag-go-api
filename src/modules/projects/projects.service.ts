import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
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
import { AuditService } from '../audit/audit.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

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

    if (query.normalizedKeyword) {
      projectQuery.andWhere(
        "(LOWER(project.name) LIKE :keyword OR LOWER(COALESCE(project.description, '')) LIKE :keyword)",
        { keyword: `%${query.normalizedKeyword.toLocaleLowerCase('vi-VN')}%` },
      );
    }
    if (query.folderId) {
      projectQuery.andWhere(
        `project.folderId IN (
          SELECT folder_closure.descendant_id
          FROM folder_closure
          WHERE folder_closure.ancestor_id = :filterFolderId
        )`,
        { filterFolderId: query.folderId },
      );
    }
    if (query.countryId) {
      projectQuery.andWhere('project.countryId = :countryId', { countryId: query.countryId });
    }
    if (query.provinceId) {
      projectQuery.andWhere('project.provinceId = :provinceId', { provinceId: query.provinceId });
    }
    if (query.categoryId) {
      projectQuery.andWhere('project.categoryId = :categoryId', { categoryId: query.categoryId });
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
    const [projects, total] = await projectQuery
      .orderBy(`project.${query.sortBy ?? 'updatedAt'}`, sortOrder)
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

  async findOne(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.projectRepository.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    await this.requireFolderAccess(project.folderId, userId, 'viewer', userType);
    const [folder, country, province, category, tags] = await Promise.all([
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
    ]);
    const thumbnail = (await this.resolveThumbnails([project])).get(project.id);
    const [enrichedProject] = await this.actorEnrichment.enrich(
      [
        Object.assign(project, {
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
    await this.auditService.record({
      projectId: created.id,
      actorUserId: userId,
      action: 'project_created',
      afterData: { name: created.name, folderId: created.folderId },
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
    await this.auditService.record({
      projectId: id,
      actorUserId: userId,
      action: 'project_updated',
      afterData: {
        name: updated.name,
        folderId: updated.folderId,
        description: updated.description,
      },
    });
    return updated;
  }

  async remove(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.findOne(id, userId, userType);
    await this.requireFolderAccess(project.folderId, userId, 'editor', userType);
    const storagePrefix = `projects/${id}/`;
    await this.dataSource.transaction(async (manager) => {
      // Assets stored under this project's prefix; one attached to another project stays.
      const ownedAssets = (await manager.query(
        `SELECT asset.id, asset.original_storage_key AS "originalStorageKey",
           EXISTS (
             SELECT 1 FROM project_media media
             WHERE media.asset_id = asset.id AND media.project_id <> $2
           ) AS shared
         FROM assets asset
         WHERE asset.original_storage_key LIKE $1 || '%'`,
        [storagePrefix, id],
      )) as Array<{ id: string; originalStorageKey: string; shared: boolean }>;
      const sharedAssets = ownedAssets.filter((asset) => asset.shared);
      const keepPrefixes = [
        ...sharedAssets.map((asset) => asset.originalStorageKey),
        ...sharedAssets.map((asset) => `${storagePrefix}variants/${asset.id}/`),
      ];
      if (sharedAssets.length > 0) {
        const variants = (await manager.query(
          'SELECT storage_key AS "storageKey" FROM asset_variants WHERE asset_id = ANY($1::uuid[])',
          [sharedAssets.map((asset) => asset.id)],
        )) as Array<{ storageKey: string }>;
        keepPrefixes.push(...variants.map((variant) => variant.storageKey));
      }

      await manager.delete(ProjectEntity, id);
      const removableAssetIds = ownedAssets
        .filter((asset) => !asset.shared)
        .map((asset) => asset.id);
      if (removableAssetIds.length > 0) {
        await manager.query('DELETE FROM assets WHERE id = ANY($1::uuid[])', [removableAssetIds]);
      }
      // Their ZIP files live under the prefix too.
      await manager.query(
        `UPDATE download_jobs
         SET status = CASE WHEN status = 'completed' THEN 'expired' ELSE 'cancelled' END,
             updated_at = now()
         WHERE project_id = $1 AND status IN ('queued', 'processing', 'completed')`,
        [id],
      );
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
      beforeData: { name: project.name, folderId: project.folderId },
    });
    return { success: true };
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
