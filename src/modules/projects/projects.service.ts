import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { TagEntity } from '../../database/entities/tag.entity';
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
  ) { }

  async list(query: ListProjectsQueryDto, userId: string) {
    const folderIds = await this.folderAccessService.accessibleFolderIds(userId);
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
    if (query.folderIds?.length) {
      projectQuery.andWhere(
        `project.folderId IN (
          SELECT folder_closure.descendant_id
          FROM folder_closure
          WHERE folder_closure.ancestor_id IN (:...filterFolderIds)
        )`,
        { filterFolderIds: query.folderIds },
      );
    } else if (query.folderId) {
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

    const [projects, total] = await projectQuery
      .orderBy('project.updatedAt', 'DESC')
      .addOrderBy('project.id', 'DESC')
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
    const thumbnailMediaIds = projects.flatMap((project) =>
      project.thumbnailProjectMediaId ? [project.thumbnailProjectMediaId] : [],
    );
    const thumbnailMedia = thumbnailMediaIds.length
      ? await this.dataSource.getRepository(ProjectMediaEntity).findBy({
        id: In(thumbnailMediaIds),
      })
      : [];
    const thumbnailAssetIds = new Map(thumbnailMedia.map((media) => [media.id, media.assetId]));
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
        thumbnailAssetId: project.thumbnailProjectMediaId
          ? (thumbnailAssetIds.get(project.thumbnailProjectMediaId) ?? null)
          : null,
        tags: (tagsByProjectId.get(project.id) ?? []).map((tag) => tag.name),
        tagIds: (tagsByProjectId.get(project.id) ?? []).map((tag) => tag.id),
      });
    });

    return new ListResponseDto(items, query.page, query.pageSize, total);
  }

  async findOne(id: string, userId: string) {
    const project = await this.projectRepository.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    await this.requireFolderAccess(project.folderId, userId, 'viewer');
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
    const thumbnailMedia = project.thumbnailProjectMediaId
      ? await this.dataSource.getRepository(ProjectMediaEntity).findOne({
        where: { id: project.thumbnailProjectMediaId, projectId: project.id },
      })
      : null;
    return Object.assign(project, {
      folderPath: folder?.pathText ?? '',
      countryName: country?.name ?? null,
      countryFlagUrl: country?.flagUrl ?? null,
      provinceName: province?.name ?? null,
      categoryName: category?.name ?? null,
      thumbnailAssetId: thumbnailMedia?.assetId ?? null,
      tagIds: tags.map((tag) => tag.id),
      tags: tags.map((tag) => tag.name),
    });
  }

  async create(dto: CreateProjectDto, userId: string) {
    await this.requireFolderAccess(dto.folderId, userId, 'editor');
    await this.validateCatalogs(dto.countryId, dto.provinceId, dto.categoryId);
    const requestedTagIds = [...new Set(dto.tagIds ?? [])];
    if (requestedTagIds.length > 0) {
      const tags = await this.tagRepository.findBy({ id: In(requestedTagIds) });
      if (tags.length !== requestedTagIds.length) {
        throw new NotFoundException('One or more tags were not found');
      }
    }

    return this.dataSource.transaction(async (manager) => {
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
  }

  async update(id: string, dto: UpdateProjectDto, userId: string) {
    const project = await this.findOne(id, userId);
    await this.requireFolderAccess(project.folderId, userId, 'editor');
    const folderId = dto.folderId ?? project.folderId;
    if (folderId !== project.folderId) {
      await this.requireFolderAccess(folderId, userId, 'editor');
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

    Object.assign(project, {
      folderId,
      name: dto.name?.trim() ?? project.name,
      description:
        dto.description === undefined ? project.description : dto.description?.trim() || null,
      categoryId,
      countryId,
      provinceId,
    });

    await this.dataSource.transaction(async (manager) => {
      await manager.save(project);
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
    return this.findOne(id, userId);
  }

  async remove(id: string, userId: string) {
    const project = await this.findOne(id, userId);
    await this.requireFolderAccess(project.folderId, userId, 'editor');
    await this.projectRepository.remove(project);
    return { success: true };
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

  private async requireFolderAccess(folderId: string, userId: string, level: 'viewer' | 'editor') {
    const allowed = await this.folderAccessService.canAccess(folderId, userId, level);
    if (!allowed) {
      throw new ForbiddenException('Insufficient folder permission');
    }
  }
}
