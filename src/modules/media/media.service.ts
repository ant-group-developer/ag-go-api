import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AssetEntity } from '../../database/entities/asset.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { FolderAccessLevel, FolderAccessService } from '../folders/folder-access.service';
import { CreateProjectMediaDto } from './dto/create-project-media.dto';
import { ReorderProjectMediaDto } from './dto/reorder-project-media.dto';
import { SetProjectThumbnailDto } from './dto/set-project-thumbnail.dto';
import { UpdateProjectMediaDto } from './dto/update-project-media.dto';

type MediaCursor = {
  sortOrder: number;
  id: string;
};

@Injectable()
export class MediaService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectMediaEntity)
    private readonly projectMediaRepository: Repository<ProjectMediaEntity>,
    private readonly folderAccessService: FolderAccessService,
  ) {}

  async list(projectId: string, userId: string, groupIds: string[], cursor?: string, limit = 50) {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, groupIds, 'viewer');

    const normalizedLimit = Math.min(Math.max(limit, 1), 100);
    const query = this.projectMediaRepository
      .createQueryBuilder('media')
      .leftJoinAndSelect('media.asset', 'asset')
      .where('media.project_id = :projectId', { projectId })
      .orderBy('media.sort_order', 'ASC')
      .addOrderBy('media.id', 'ASC')
      .take(normalizedLimit + 1);

    if (cursor) {
      const decoded = this.decodeCursor(cursor);
      query.andWhere(
        '(media.sort_order > :cursorSortOrder OR (media.sort_order = :cursorSortOrder AND media.id > :cursorId))',
        {
          cursorSortOrder: decoded.sortOrder,
          cursorId: decoded.id,
        },
      );
    }

    const rows = await query.getMany();
    const hasNextPage = rows.length > normalizedLimit;
    const items = hasNextPage ? rows.slice(0, normalizedLimit) : rows;
    return {
      items,
      nextCursor: hasNextPage ? this.encodeCursor(items[items.length - 1]) : null,
    };
  }

  async attach(projectId: string, dto: CreateProjectMediaDto, userId: string, groupIds: string[]) {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, groupIds, 'editor');

    return this.dataSource.transaction(async (manager) => {
      let asset: AssetEntity;
      if (dto.assetId) {
        const existingAsset = await manager.findOne(AssetEntity, {
          where: { id: dto.assetId },
        });
        if (!existingAsset) {
          throw new NotFoundException('Asset not found');
        }
        asset = existingAsset;
      } else {
        if (
          !dto.assetType ||
          !dto.originalFilename ||
          !dto.mimeType ||
          dto.fileSizeBytes === undefined
        ) {
          throw new BadRequestException('Asset metadata is required');
        }
        asset = await manager.save(
          manager.create(AssetEntity, {
            id: uuidv7(),
            assetType: dto.assetType,
            originalFilename: dto.originalFilename.trim(),
            extension: dto.extension?.trim() || null,
            mimeType: dto.mimeType.trim(),
            fileSizeBytes: String(dto.fileSizeBytes),
            originalBucket: dto.originalBucket?.trim() || 'ag-go-media',
            originalStorageKey:
              dto.originalStorageKey?.trim() ||
              `projects/${projectId}/assets/${uuidv7()}-${dto.originalFilename.trim()}`,
            processingStatus: 'uploaded',
            sourceType: 'local',
            sourceMetadata: {},
            createdBy: userId,
          }),
        );
      }

      const duplicate = await manager.findOne(ProjectMediaEntity, {
        where: { projectId, assetId: asset.id },
      });
      if (duplicate) {
        throw new ConflictException('Asset is already attached to this project');
      }

      const maxSortOrder = await manager
        .createQueryBuilder(ProjectMediaEntity, 'media')
        .select('MAX(media.sort_order)', 'max')
        .where('media.project_id = :projectId', { projectId })
        .getRawOne<{ max: string | null }>();

      const media = await manager.save(
        manager.create(ProjectMediaEntity, {
          id: uuidv7(),
          projectId,
          assetId: asset.id,
          sortOrder: dto.sortOrder ?? Number(maxSortOrder?.max ?? -1) + 1,
          caption: dto.caption?.trim() || null,
          createdBy: userId,
        }),
      );
      await this.refreshProjectCounters(manager, projectId);
      return this.findMedia(media.id, manager);
    });
  }

  async update(mediaId: string, dto: UpdateProjectMediaDto, userId: string, groupIds: string[]) {
    const media = await this.getMedia(mediaId);
    const project = await this.getProject(media.projectId);
    await this.requireProjectAccess(project, userId, groupIds, 'editor');

    Object.assign(media, {
      sortOrder: dto.sortOrder ?? media.sortOrder,
      caption: dto.caption === undefined ? media.caption : dto.caption.trim() || null,
    });
    return this.projectMediaRepository.save(media);
  }

  async remove(mediaId: string, userId: string, groupIds: string[]): Promise<void> {
    const media = await this.getMedia(mediaId);
    const project = await this.getProject(media.projectId);
    await this.requireProjectAccess(project, userId, groupIds, 'editor');

    await this.dataSource.transaction(async (manager) => {
      if (project.thumbnailProjectMediaId === mediaId) {
        await manager.update(ProjectEntity, project.id, { thumbnailProjectMediaId: null });
      }
      await manager.delete(ProjectMediaEntity, mediaId);
      await this.refreshProjectCounters(manager, project.id);
    });
  }

  async reorder(
    projectId: string,
    dto: ReorderProjectMediaDto,
    userId: string,
    groupIds: string[],
  ): Promise<void> {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, groupIds, 'editor');
    if (new Set(dto.mediaIds).size !== dto.mediaIds.length) {
      throw new BadRequestException('mediaIds must be unique');
    }

    const media = await this.projectMediaRepository.find({
      where: { projectId, id: In(dto.mediaIds) },
    });
    if (media.length !== dto.mediaIds.length) {
      throw new BadRequestException('mediaIds must belong to the project');
    }

    await this.dataSource.transaction(async (manager) => {
      for (const [index, id] of dto.mediaIds.entries()) {
        await manager.update(ProjectMediaEntity, { id, projectId }, { sortOrder: index });
      }
    });
  }

  async setThumbnail(
    projectId: string,
    dto: SetProjectThumbnailDto,
    userId: string,
    groupIds: string[],
  ) {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, groupIds, 'editor');
    if (dto.projectMediaId) {
      const media = await this.projectMediaRepository.findOne({
        where: { id: dto.projectMediaId, projectId },
      });
      if (!media) {
        throw new BadRequestException('Thumbnail media must belong to the project');
      }
    }

    project.thumbnailProjectMediaId = dto.projectMediaId ?? null;
    return this.projectRepository.save(project);
  }

  private async getProject(projectId: string): Promise<ProjectEntity> {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }

  private async getMedia(mediaId: string): Promise<ProjectMediaEntity> {
    const media = await this.projectMediaRepository.findOne({ where: { id: mediaId } });
    if (!media) {
      throw new NotFoundException('Project media not found');
    }
    return media;
  }

  private async requireProjectAccess(
    project: ProjectEntity,
    userId: string,
    groupIds: string[],
    minimum: FolderAccessLevel,
  ): Promise<void> {
    const allowed = await this.folderAccessService.canAccess(
      project.folderId,
      userId,
      groupIds,
      minimum,
    );
    if (!allowed) {
      throw new ForbiddenException('Insufficient project permission');
    }
  }

  private async findMedia(
    mediaId: string,
    manager: import('typeorm').EntityManager,
  ): Promise<ProjectMediaEntity> {
    const media = await manager
      .createQueryBuilder(ProjectMediaEntity, 'media')
      .leftJoinAndSelect('media.asset', 'asset')
      .where('media.id = :mediaId', { mediaId })
      .getOne();
    if (!media) {
      throw new NotFoundException('Project media not found');
    }
    return media;
  }

  private async refreshProjectCounters(
    manager: import('typeorm').EntityManager,
    projectId: string,
  ): Promise<void> {
    const aggregate = await manager
      .createQueryBuilder(ProjectMediaEntity, 'media')
      .innerJoin(AssetEntity, 'asset', 'asset.id = media.asset_id')
      .select('COUNT(*)', 'totalMedia')
      .addSelect("COUNT(*) FILTER (WHERE asset.asset_type = 'image')", 'imageCount')
      .addSelect("COUNT(*) FILTER (WHERE asset.asset_type = 'video')", 'videoCount')
      .addSelect('COALESCE(SUM(asset.file_size_bytes), 0)', 'originalBytes')
      .where('media.project_id = :projectId', { projectId })
      .getRawOne<{
        totalMedia: string;
        imageCount: string;
        videoCount: string;
        originalBytes: string;
      }>();

    const totalMedia = Number(aggregate?.totalMedia ?? 0);
    const evaluationStatus = totalMedia === 0 ? 'draft' : 'pending';
    await manager.update(ProjectEntity, projectId, {
      mediaCount: totalMedia,
      imageCount: Number(aggregate?.imageCount ?? 0),
      videoCount: Number(aggregate?.videoCount ?? 0),
      originalBytes: String(aggregate?.originalBytes ?? 0),
      evaluationStatus,
    });

    await manager.save(
      manager.create(ProjectEvaluationSummaryEntity, {
        projectId,
        totalMedia,
        pendingCount: totalMedia,
        approvedCount: 0,
        rejectedCount: 0,
        evaluationStatus,
      }),
    );
  }

  private encodeCursor(media: ProjectMediaEntity): string {
    return Buffer.from(
      JSON.stringify({ sortOrder: media.sortOrder, id: media.id } satisfies MediaCursor),
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): MediaCursor {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as MediaCursor;
      if (!Number.isInteger(parsed.sortOrder) || typeof parsed.id !== 'string') {
        throw new Error('Invalid cursor');
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid media cursor');
    }
  }
}
