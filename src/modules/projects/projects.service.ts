import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';

@Injectable()
export class ProjectsService {
  constructor(
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
    @InjectRepository(ProjectEvaluationSummaryEntity)
    private readonly summaryRepository: Repository<ProjectEvaluationSummaryEntity>,
    private readonly folderAccessService: FolderAccessService,
  ) {}

  async list(userId: string, groupIds: string[]) {
    const folderIds = await this.folderAccessService.accessibleFolderIds(userId, groupIds);
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

  async findOne(id: string, userId: string, groupIds: string[]) {
    const project = await this.projectRepository.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    await this.requireFolderAccess(project.folderId, userId, groupIds, 'viewer');
    return project;
  }

  async create(dto: CreateProjectDto, userId: string, groupIds: string[]) {
    await this.requireFolderAccess(dto.folderId, userId, groupIds, 'editor');
    await this.validateCatalogs(dto.countryId, dto.provinceId, dto.categoryId);
    const project = await this.projectRepository.save(
      this.projectRepository.create({
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
    await this.summaryRepository.save(
      this.summaryRepository.create({
        projectId: project.id,
        totalMedia: 0,
        pendingCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        evaluationStatus: 'draft',
      }),
    );
    return project;
  }

  async update(id: string, dto: UpdateProjectDto, userId: string, groupIds: string[]) {
    const project = await this.findOne(id, userId, groupIds);
    await this.requireFolderAccess(project.folderId, userId, groupIds, 'editor');
    await this.validateCatalogs(dto.countryId, dto.provinceId, dto.categoryId);
    Object.assign(project, {
      name: dto.name?.trim() ?? project.name,
      description: dto.description === undefined ? project.description : dto.description.trim(),
      categoryId: dto.categoryId === undefined ? project.categoryId : dto.categoryId,
      countryId: dto.countryId === undefined ? project.countryId : dto.countryId,
      provinceId: dto.provinceId === undefined ? project.provinceId : dto.provinceId,
    });
    return this.projectRepository.save(project);
  }

  async remove(id: string, userId: string, groupIds: string[]) {
    const project = await this.findOne(id, userId, groupIds);
    await this.requireFolderAccess(project.folderId, userId, groupIds, 'editor');
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

  private async requireFolderAccess(
    folderId: string,
    userId: string,
    groupIds: string[],
    level: 'viewer' | 'editor',
  ) {
    const allowed = await this.folderAccessService.canAccess(folderId, userId, groupIds, level);
    if (!allowed) {
      throw new ForbiddenException('Insufficient folder permission');
    }
  }
}
