import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { isAdminUserType } from '../../common/auth/user-type';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectMediaEvaluationEntity } from '../../database/entities/project-media-evaluation.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { AuditService } from '../audit/audit.service';
import { FolderAccessLevel, FolderAccessService } from '../folders/folder-access.service';
import { isPreviewVariantCode, pickPreviewVariant } from '../render/render-sizes';
import {
  findActiveRenderProfile,
  isVariantServable,
  THUMBNAIL_VARIANT_CODE,
} from '../render/watermark-policy';
import { CreateProjectMediaDto } from './dto/create-project-media.dto';
import { ReorderProjectMediaDto } from './dto/reorder-project-media.dto';
import { SetProjectThumbnailDto } from './dto/set-project-thumbnail.dto';
import { UpdateProjectMediaDto } from './dto/update-project-media.dto';
import { deriveProjectEvaluationStatus } from './evaluation-status';

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
    private readonly actorEnrichment: ActorEnrichmentService,
    private readonly auditService: AuditService,
    private readonly config: ConfigService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async list(
    projectId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    cursor?: string,
    limit = 50,
  ) {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, 'viewer', userType);

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
    const variants = await this.dataSource.getRepository(AssetVariantEntity).findBy({
      assetId: In(items.map((item) => item.assetId)),
    });
    const activeProfile = await findActiveRenderProfile(
      this.dataSource.getRepository(RenderProfileEntity),
    );
    const servable = variants.filter(
      (variant) => variant.status === 'ready' && isVariantServable(variant, activeProfile),
    );
    const ttl = this.config.getOrThrow<number>('R2_PRESIGNED_URL_TTL_SECONDS');
    const enrichedItems = await this.actorEnrichment.enrich(
      (await Promise.all(
        items.map(async (item) => {
          const assetVariants = servable.filter((variant) => variant.assetId === item.assetId);
          const previews = assetVariants
            .filter((variant) => isPreviewVariantCode(variant.variantCode))
            .sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
          const largestPreview = pickPreviewVariant(previews);
          const thumbnail = assetVariants.find(
            (variant) => variant.variantCode === THUMBNAIL_VARIANT_CODE,
          );
          const sourceMetadata = item.asset.sourceMetadata ?? {};
          return Object.assign(item, {
            durationSeconds: readNumberMetadata(sourceMetadata, ['durationSeconds', 'duration']),
            width: readNumberMetadata(sourceMetadata, ['width']) ?? largestPreview?.width ?? null,
            height:
              readNumberMetadata(sourceMetadata, ['height']) ?? largestPreview?.height ?? null,
            // Lists show the un-watermarked thumbnail; the watermarked preview is for viewing.
            thumbnailUrl: thumbnail
              ? await this.storage.getPresignedGetUrl(thumbnail.storageKey, thumbnail.mimeType, ttl)
              : null,
            previewUrl: largestPreview
              ? await this.storage.getPresignedGetUrl(
                  largestPreview.storageKey,
                  largestPreview.mimeType,
                  ttl,
                )
              : null,
            previewVariants: previews.map((variant) => ({
              variantCode: variant.variantCode,
              width: variant.width,
              height: variant.height,
            })),
            previewVariantCode: largestPreview?.variantCode ?? null,
            watermarkVariant: largestPreview?.hasWatermark ? largestPreview.variantCode : null,
            creatorName:
              typeof sourceMetadata.driveCreator === 'string' ? sourceMetadata.driveCreator : null,
            modifiedAt:
              typeof sourceMetadata.modifiedTime === 'string'
                ? sourceMetadata.modifiedTime
                : item.asset.updatedAt,
          });
        }),
      )) as unknown as Array<Record<string, unknown>>,
      [{ id: 'createdBy', target: 'createdByUser' }],
    );
    return {
      items: enrichedItems,
      nextCursor: hasNextPage ? this.encodeCursor(items[items.length - 1]) : null,
    };
  }

  async attach(
    projectId: string,
    dto: CreateProjectMediaDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ) {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, 'editor', userType);

    const created = await this.dataSource.transaction(async (manager) => {
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
              `projects/${projectId}/originals/${uuidv7()}-${dto.originalFilename.trim()}`,
            processingStatus: 'uploaded',
            processingError: null,
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
      const created = await this.findMedia(media.id, manager);
      return created;
    });
    await this.auditService.record({
      projectId,
      projectMediaId: created.id,
      actorUserId: userId,
      action: 'media_attached',
      afterData: { assetId: created.assetId },
    });
    return created;
  }

  async update(
    mediaId: string,
    dto: UpdateProjectMediaDto,
    userId: string,
    permissions: string[],
    userType: 'ADMIN' | 'USER' | undefined,
  ) {
    const evaluationMutation = dto.evaluationStatus !== undefined || dto.comment !== undefined;
    const contentMutation = dto.sortOrder !== undefined || dto.caption !== undefined;
    if (
      evaluationMutation &&
      !isAdminUserType(userType) &&
      !permissions.includes('go.project.evaluate')
    ) {
      throw new ForbiddenException('Missing evaluation permission');
    }
    if (contentMutation && !isAdminUserType(userType) && !permissions.includes('go.project.edit')) {
      throw new ForbiddenException('Missing project edit permission');
    }
    let projectId = '';
    let projectMediaId = '';
    let previousEvaluationStatus = '';
    const updated = await this.dataSource.transaction(async (manager) => {
      const media = await manager
        .createQueryBuilder(ProjectMediaEntity, 'media')
        .leftJoinAndSelect('media.asset', 'asset')
        .where('media.id = :mediaId', { mediaId })
        // Only the media row: Postgres rejects FOR UPDATE on the nullable side of a LEFT JOIN.
        .setLock('pessimistic_write', undefined, ['media'])
        .getOne();
      if (!media) {
        throw new NotFoundException('Project media not found');
      }
      const project = await manager.findOne(ProjectEntity, {
        where: { id: media.projectId },
      });
      if (!project) {
        throw new NotFoundException('Project not found');
      }
      await this.requireProjectAccess(project, userId, 'editor', userType, manager);
      projectId = project.id;
      projectMediaId = media.id;
      previousEvaluationStatus = media.evaluationStatus;

      Object.assign(media, {
        sortOrder: dto.sortOrder ?? media.sortOrder,
        caption: dto.caption === undefined ? media.caption : dto.caption.trim() || null,
        evaluationStatus: dto.evaluationStatus ?? media.evaluationStatus,
      });
      const updatedMedia = await manager.save(media);
      if (dto.evaluationStatus !== undefined || dto.comment !== undefined) {
        await manager.save(
          manager.create(ProjectMediaEvaluationEntity, {
            id: uuidv7(),
            projectMediaId: media.id,
            evaluationStatus: media.evaluationStatus,
            comment: dto.comment?.trim() || null,
            evaluatedBy: userId,
          }),
        );
      }
      if (dto.evaluationStatus !== undefined || dto.comment !== undefined) {
        await this.refreshProjectEvaluation(manager, media.projectId);
      }
      return this.findMedia(updatedMedia.id, manager);
    });
    await this.auditService.record({
      projectId,
      projectMediaId,
      actorUserId: userId,
      action:
        dto.evaluationStatus !== undefined || dto.comment !== undefined
          ? 'evaluation_changed'
          : 'media_updated',
      afterData: {
        previousEvaluationStatus,
        evaluationStatus: dto.evaluationStatus ?? previousEvaluationStatus,
        comment: dto.comment ?? null,
      },
    });
    return updated;
  }

  async listEvaluationHistory(mediaId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const media = await this.getMedia(mediaId);
    const project = await this.getProject(media.projectId);
    await this.requireProjectAccess(project, userId, 'viewer', userType);
    const evaluations = await this.dataSource.getRepository(ProjectMediaEvaluationEntity).find({
      where: { projectMediaId: mediaId },
      order: { createdAt: 'DESC' },
    });
    const enriched = await this.actorEnrichment.enrich(
      evaluations as unknown as Array<Record<string, unknown>>,
      [{ id: 'evaluatedBy', target: 'evaluatedByUser' }],
    );
    return enriched.map((evaluation) => ({
      ...evaluation,
      commentedByUser: evaluation.evaluatedByUser ?? null,
    }));
  }

  async remove(mediaId: string, userId: string, userType?: 'ADMIN' | 'USER'): Promise<void> {
    const media = await this.getMedia(mediaId);
    const project = await this.getProject(media.projectId);
    await this.requireProjectAccess(project, userId, 'editor', userType);

    await this.dataSource.transaction(async (manager) => {
      if (project.thumbnailProjectMediaId === mediaId) {
        await manager.update(ProjectEntity, project.id, { thumbnailProjectMediaId: null });
      }
      await manager.delete(ProjectMediaEntity, mediaId);
      await this.refreshProjectCounters(manager, project.id);
    });
    await this.auditService.record({
      projectId: project.id,
      projectMediaId: mediaId,
      actorUserId: userId,
      action: 'media_deleted',
      beforeData: { assetId: media.assetId },
    });
  }

  async reorder(
    projectId: string,
    dto: ReorderProjectMediaDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, 'editor', userType);
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
    userType?: 'ADMIN' | 'USER',
  ) {
    const project = await this.getProject(projectId);
    await this.requireProjectAccess(project, userId, 'editor', userType);
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

  /**
   * Inside a transaction, pass its `manager`: the check then runs on the transaction's own
   * connection instead of waiting for a second pooled one while the first stays held.
   */
  private async requireProjectAccess(
    project: ProjectEntity,
    userId: string,
    minimum: FolderAccessLevel,
    userType?: 'ADMIN' | 'USER',
    manager?: import('typeorm').EntityManager,
  ): Promise<void> {
    const allowed = await this.folderAccessService.canAccess(
      project.folderId,
      userId,
      minimum,
      userType,
      manager,
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
    await manager.update(ProjectEntity, projectId, {
      mediaCount: totalMedia,
      imageCount: Number(aggregate?.imageCount ?? 0),
      videoCount: Number(aggregate?.videoCount ?? 0),
      originalBytes: String(aggregate?.originalBytes ?? 0),
    });
    await this.refreshProjectEvaluation(manager, projectId);
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

  private async refreshProjectEvaluation(
    manager: import('typeorm').EntityManager,
    projectId: string,
  ): Promise<void> {
    const counts = await manager
      .createQueryBuilder(ProjectMediaEntity, 'media')
      .select('COUNT(*)', 'total')
      .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'pending')", 'pending')
      .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'approved')", 'approved')
      .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'rejected')", 'rejected')
      .where('media.project_id = :projectId', { projectId })
      .getRawOne<{ total: string; pending: string; approved: string; rejected: string }>();

    const total = Number(counts?.total ?? 0);
    const pending = Number(counts?.pending ?? 0);
    const approved = Number(counts?.approved ?? 0);
    const rejected = Number(counts?.rejected ?? 0);
    const evaluationStatus = deriveProjectEvaluationStatus(total, pending, approved, rejected);

    await manager.update(ProjectEntity, projectId, { evaluationStatus });
    await manager.upsert(
      ProjectEvaluationSummaryEntity,
      {
        projectId,
        totalMedia: total,
        pendingCount: pending,
        approvedCount: approved,
        rejectedCount: rejected,
        evaluationStatus,
      },
      ['projectId'],
    );
  }
}

function readNumberMetadata(metadata: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}
