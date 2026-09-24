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
import { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import { isAdminUserType } from '../../common/auth/user-type';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { MediaQueueService } from '../../infra/queue/media-queue.service';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateRenderBatchDto } from './dto/create-render-batch.dto';
import {
  RerenderMediaType,
  RerenderWatermarkDto,
  RerenderWatermarkScope,
} from './dto/rerender-watermark.dto';
import { UpdateRenderProfileDto } from './dto/update-render-profile.dto';
import { normalizeWatermarkConfig } from './watermark-config';

@Injectable()
export class RenderService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(RenderProfileEntity)
    private readonly profileRepository: Repository<RenderProfileEntity>,
    @InjectRepository(RenderBatchEntity)
    private readonly batchRepository: Repository<RenderBatchEntity>,
    @InjectRepository(MediaRenderJobEntity)
    private readonly jobRepository: Repository<MediaRenderJobEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(ProjectMediaEntity)
    private readonly mediaRepository: Repository<ProjectMediaEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    private readonly folderAccess: FolderAccessService,
    private readonly mediaQueue: MediaQueueService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  listProfiles(): Promise<RenderProfileEntity[]> {
    return this.profileRepository.find({
      where: { isActive: true },
      order: { code: 'ASC', profileVersion: 'DESC' },
    });
  }

  async updateProfile(
    id: string,
    dto: UpdateRenderProfileDto,
    userId: string,
  ): Promise<RenderProfileEntity> {
    const current = await this.profileRepository.findOne({ where: { id, isActive: true } });
    if (!current) {
      throw new NotFoundException('Active render profile not found');
    }
    if (dto.watermarkConfig?.logoAssetId) {
      const logo = await this.assetRepository.findOne({
        where: { id: dto.watermarkConfig.logoAssetId, assetType: 'image' },
      });
      if (!logo) {
        throw new BadRequestException('Watermark logo asset must be an image');
      }
    }

    return this.dataSource.transaction(async (manager) => {
      const latest = await manager.findOne(RenderProfileEntity, {
        where: { code: current.code },
        order: { profileVersion: 'DESC' },
      });
      if (!latest) {
        throw new NotFoundException('Render profile not found');
      }

      await manager.update(
        RenderProfileEntity,
        { code: latest.code, isActive: true },
        { isActive: false },
      );

      return manager.save(
        manager.create(RenderProfileEntity, {
          id: uuidv7(),
          name: dto.name ?? latest.name,
          code: latest.code,
          profileVersion: latest.profileVersion + 1,
          outputFormat: dto.outputFormat ?? latest.outputFormat,
          maxWidth: dto.maxWidth === undefined ? latest.maxWidth : dto.maxWidth,
          maxHeight: dto.maxHeight === undefined ? latest.maxHeight : dto.maxHeight,
          imageQuality: dto.imageQuality ?? latest.imageQuality,
          videoBitrateBps:
            dto.videoBitrateBps === undefined ? latest.videoBitrateBps : dto.videoBitrateBps,
          watermarkEnabled: dto.watermarkEnabled ?? latest.watermarkEnabled,
          watermarkConfig:
            dto.watermarkConfig === undefined
              ? latest.watermarkConfig
              : normalizeWatermarkConfig({
                  ...(latest.watermarkConfig ?? {}),
                  ...(dto.watermarkConfig as Record<string, unknown>),
                }),
          isActive: true,
          createdBy: userId,
        }),
      );
    });
  }

  async createBatch(
    dto: CreateRenderBatchDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<RenderBatchEntity> {
    if (!dto.projectId && !dto.folderId && !dto.projectMediaIds?.length) {
      throw new BadRequestException('projectId, folderId or projectMediaIds is required');
    }

    const profile = dto.renderProfileId
      ? await this.profileRepository.findOne({ where: { id: dto.renderProfileId, isActive: true } })
      : await this.profileRepository.findOne({
          where: { code: 'default', isActive: true },
          order: { profileVersion: 'DESC' },
        });
    if (!profile) {
      throw new ConflictException('Default render profile is not configured');
    }

    const media = await this.resolveMedia(dto);
    if (media.length === 0) {
      throw new NotFoundException('No project media found for render batch');
    }

    const projectIds = [...new Set(media.map((item) => item.projectId))];
    const projects = await this.projectRepository.findBy({ id: In(projectIds) });
    const projectById = new Map(projects.map((project) => [project.id, project]));
    for (const projectId of projectIds) {
      const project = projectById.get(projectId);
      if (!project) {
        throw new NotFoundException('Project not found');
      }
      if (!(await this.folderAccess.canAccess(project.folderId, userId, 'manager', userType))) {
        throw new ForbiddenException('Render batch requires folder manager permission');
      }
    }

    const existingJobs = await this.jobRepository.find({
      where: {
        assetId: In([...new Set(media.map((item) => item.assetId))]),
        renderProfileId: profile.id,
        renderVersion: profile.profileVersion,
        status: In(['queued', 'processing', 'completed']),
      },
    });
    const existingAssetIds = new Set(existingJobs.map((job) => job.assetId));
    const jobsToQueue = media.filter((item) => !existingAssetIds.has(item.assetId));

    const batch = await this.dataSource.transaction(async (manager) => {
      const savedBatch = await manager.save(
        manager.create(RenderBatchEntity, {
          id: uuidv7(),
          projectId: dto.projectId ?? (projectIds.length === 1 ? projectIds[0] : null),
          folderId: dto.folderId ?? null,
          renderProfileId: profile.id,
          status: jobsToQueue.length > 0 ? 'queued' : 'completed',
          totalJobs: jobsToQueue.length,
          completedJobs: 0,
          failedJobs: 0,
          progressPercent: jobsToQueue.length > 0 ? 0 : 100,
          errorMessage: null,
          createdBy: userId,
        }),
      );

      await manager.insert(
        MediaRenderJobEntity,
        jobsToQueue.map((item) => ({
          id: uuidv7(),
          assetId: item.assetId,
          renderProfileId: profile.id,
          renderBatchId: savedBatch.id,
          renderVersion: profile.profileVersion,
          queueJobId: null,
          dedupeKey: `${item.assetId}:${profile.id}:${profile.profileVersion}`,
          status: 'queued' as const,
          progressPercent: 0,
          progressMessage: 'Queued for batch rendering',
          attemptCount: 0,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          createdBy: userId,
        })),
      );
      return savedBatch;
    });

    const jobs = await this.jobRepository.find({ where: { renderBatchId: batch.id } });
    await Promise.all(
      jobs.map((job) =>
        this.mediaQueue.addProcessingJob({
          eventId: job.id,
          assetId: job.assetId,
          renderJobId: job.id,
          userId,
        }),
      ),
    );
    const [enrichedBatch] = await this.actorEnrichment.enrich(
      [batch as unknown as Record<string, unknown>],
      [{ id: 'createdBy', target: 'createdByUser' }],
    );
    return enrichedBatch as unknown as RenderBatchEntity;
  }

  async rerenderWatermark(dto: RerenderWatermarkDto, userId: string, userType?: 'ADMIN' | 'USER') {
    const mediaQuery = this.mediaRepository
      .createQueryBuilder('media')
      .innerJoin(AssetEntity, 'asset', 'asset.id = media.asset_id')
      .innerJoin(ProjectEntity, 'project', 'project.id = media.project_id');

    if (dto.scope === RerenderWatermarkScope.PROJECT) {
      if (!dto.projectIds?.length) {
        throw new BadRequestException('projectIds is required for PROJECT scope');
      }
      mediaQuery.andWhere('media.project_id IN (:...projectIds)', {
        projectIds: [...new Set(dto.projectIds)],
      });
    }
    if (dto.scope === RerenderWatermarkScope.FILTER) {
      if (dto.dateFrom)
        mediaQuery.andWhere('project.created_at >= :dateFrom', { dateFrom: dto.dateFrom });
      if (dto.dateTo) mediaQuery.andWhere('project.created_at <= :dateTo', { dateTo: dto.dateTo });
      if (dto.categoryIds?.length) {
        mediaQuery.andWhere('project.category_id IN (:...categoryIds)', {
          categoryIds: [...new Set(dto.categoryIds)],
        });
      }
    }
    if (dto.scope === RerenderWatermarkScope.NOT_WATERMARKED) {
      mediaQuery.andWhere(
        `NOT EXISTS (
          SELECT 1 FROM asset_variants av
          WHERE av.asset_id = media.asset_id
            AND av.status = 'ready'
            AND av.has_watermark = true
        )`,
      );
    }
    if (dto.mediaType === RerenderMediaType.IMAGE) {
      mediaQuery.andWhere('asset.asset_type = :assetType', { assetType: 'image' });
    } else if (dto.mediaType === RerenderMediaType.VIDEO) {
      mediaQuery.andWhere('asset.asset_type = :assetType', { assetType: 'video' });
    }

    const media = await mediaQuery.select('media.id', 'id').getRawMany<{ id: string }>();
    if (media.length === 0) {
      return { scope: dto.scope, matchedMedia: 0, enqueuedJobs: 0, batchId: null };
    }
    const batch = await this.createBatch(
      { projectMediaIds: media.map((item) => item.id) },
      userId,
      userType,
    );
    return {
      scope: dto.scope,
      matchedMedia: media.length,
      enqueuedJobs: batch.totalJobs,
      batchId: batch.id,
    };
  }

  async getBatch(
    id: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<RenderBatchEntity> {
    const batch = await this.batchRepository.findOne({ where: { id } });
    if (!batch) {
      throw new NotFoundException('Render batch not found');
    }
    await this.assertBatchAccess(batch, userId, userType);
    const [enrichedBatch] = await this.actorEnrichment.enrich(
      [batch as unknown as Record<string, unknown>],
      [{ id: 'createdBy', target: 'createdByUser' }],
    );
    return enrichedBatch as unknown as RenderBatchEntity;
  }

  async listBatches(projectId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (
      !project ||
      !(await this.folderAccess.canAccess(project.folderId, userId, 'viewer', userType))
    ) {
      throw new ForbiddenException('Insufficient project permission');
    }
    return this.batchRepository.find({
      where: { projectId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async listAllBatches(userId: string, userType?: 'ADMIN' | 'USER') {
    const batches = await this.batchRepository.find({
      order: { createdAt: 'DESC' },
    });
    if (isAdminUserType(userType)) {
      return batches;
    }
    const visible: RenderBatchEntity[] = [];
    for (const batch of batches) {
      if (batch.projectId) {
        const project = await this.projectRepository.findOne({ where: { id: batch.projectId } });
        if (
          project &&
          (await this.folderAccess.canAccess(project.folderId, userId, 'viewer', userType))
        ) {
          visible.push(batch);
        }
      } else if (
        batch.folderId &&
        (await this.folderAccess.canAccess(batch.folderId, userId, 'viewer', userType))
      ) {
        visible.push(batch);
      }
    }
    return visible;
  }

  async listJobs(batchId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const batch = await this.getBatch(batchId, userId, userType);
    return this.jobRepository.find({
      where: { renderBatchId: batch.id },
      order: { createdAt: 'ASC' },
    });
  }

  async retryJob(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const job = await this.jobRepository.findOne({ where: { id } });
    if (!job?.renderBatchId) {
      throw new NotFoundException('Render job not found');
    }
    await this.getBatch(job.renderBatchId, userId, userType);
    if (job.status !== 'failed') {
      throw new ConflictException('Only failed render jobs can be retried');
    }
    await this.jobRepository.update(id, {
      status: 'queued',
      progressPercent: 0,
      progressMessage: 'Queued for retry',
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
    });
    await this.mediaQueue.addProcessingJob({
      eventId: job.id,
      assetId: job.assetId,
      renderJobId: job.id,
      userId,
    });
    return this.jobRepository.findOneOrFail({ where: { id } });
  }

  async cancelBatch(
    id: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<RenderBatchEntity> {
    const batch = await this.getBatch(id, userId, userType);
    if (['completed', 'failed', 'cancelled'].includes(batch.status)) {
      return batch;
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.update(RenderBatchEntity, id, { status: 'cancelled' });
      await manager.update(
        MediaRenderJobEntity,
        { renderBatchId: id, status: 'queued' },
        { status: 'cancelled', finishedAt: new Date(), progressMessage: 'Cancelled by user' },
      );
    });
    return this.batchRepository.findOneOrFail({ where: { id } });
  }

  private async resolveMedia(dto: CreateRenderBatchDto): Promise<ProjectMediaEntity[]> {
    if (dto.projectMediaIds?.length) {
      return this.mediaRepository.findBy({ id: In([...new Set(dto.projectMediaIds)]) });
    }
    if (dto.projectId) {
      return this.mediaRepository.findBy({ projectId: dto.projectId });
    }
    const projects = await this.projectRepository.findBy({ folderId: dto.folderId });
    if (projects.length === 0) {
      return [];
    }
    return this.mediaRepository.findBy({ projectId: In(projects.map((project) => project.id)) });
  }

  private async assertBatchAccess(
    batch: RenderBatchEntity,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    if (batch.projectId) {
      const project = await this.projectRepository.findOne({ where: { id: batch.projectId } });
      if (
        !project ||
        !(await this.folderAccess.canAccess(project.folderId, userId, 'manager', userType))
      ) {
        throw new ForbiddenException('Insufficient render batch permission');
      }
      return;
    }
    if (
      batch.folderId &&
      !(await this.folderAccess.canAccess(batch.folderId, userId, 'manager', userType))
    ) {
      throw new ForbiddenException('Insufficient render batch permission');
    }
  }
}
