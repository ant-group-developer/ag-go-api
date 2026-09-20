import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { TagEntity } from '../../database/entities/tag.entity';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateProjectDto } from './dto/create-project.dto';
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
  ) {}

  async list(userId: string) {
    const folderIds = await this.folderAccessService.accessibleFolderIds(userId);
    if (folderIds.length === 0) {
      return { items: [], nextCursor: null };
    }
    const items = await this.projectRepository.find({
      where: { folderId: In(folderIds) },
      order: { updatedAt: 'DESC', id: 'DESC' },
      take: 50,
    });
    return { items, nextCursor: null };
  }

  async findOne(id: string, userId: string) {
    const project = await this.projectRepository.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    await this.requireFolderAccess(project.folderId, userId, 'viewer');
    const tags = (await this.dataSource.query(
      `SELECT tag.id, tag.name
       FROM project_tags project_tag
       INNER JOIN tags tag ON tag.id = project_tag.tag_id
       WHERE project_tag.project_id = $1
       ORDER BY tag.normalized_name ASC`,
      [project.id],
    )) as Array<{ id: string; name: string }>;
    return Object.assign(project, {
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
