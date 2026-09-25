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
import { DownloadJobItemEntity } from '../../database/entities/download-job-item.entity';
import { DownloadJobEntity } from '../../database/entities/download-job.entity';
import { DownloadLogEntity } from '../../database/entities/download-log.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { DownloadQueueService } from '../../infra/queue/download-queue.service';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { FolderAccessService } from '../folders/folder-access.service';
import { CreateDownloadDto } from './dto/create-download.dto';
import { findRenderedVariant } from './rendered-variant';

type RequestMetadata = {
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class DownloadsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(DownloadJobEntity)
    private readonly jobRepository: Repository<DownloadJobEntity>,
    @InjectRepository(DownloadJobItemEntity)
    private readonly itemRepository: Repository<DownloadJobItemEntity>,
    @InjectRepository(DownloadLogEntity)
    private readonly logRepository: Repository<DownloadLogEntity>,
    @InjectRepository(ProjectMediaEntity)
    private readonly mediaRepository: Repository<ProjectMediaEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepository: Repository<AssetVariantEntity>,
    @InjectRepository(RenderProfileEntity)
    private readonly profileRepository: Repository<RenderProfileEntity>,
    private readonly folderAccess: FolderAccessService,
    private readonly config: ConfigService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly downloadQueue: DownloadQueueService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  async create(
    dto: CreateDownloadDto,
    userId: string,
    permissions: string[],
    userType: 'ADMIN' | 'USER' | undefined,
    idempotencyKey: string | undefined,
    metadata: RequestMetadata,
  ) {
    const requiredPermission =
      dto.downloadType === 'original'
        ? 'go.project.download_original'
        : 'go.project.download_rendered';
    if (!isAdminUserType(userType) && !permissions.includes(requiredPermission)) {
      await this.recordLog({
        userId,
        dto,
        status: 'denied',
        errorCode: 'MISSING_DOWNLOAD_PERMISSION',
        metadata,
      });
      throw new ForbiddenException('Missing download permission');
    }
    const media = await this.resolveMedia(dto);
    if (media.length === 0) {
      await this.recordLog({
        userId,
        dto,
        status: 'denied',
        errorCode: 'NO_MEDIA',
        metadata,
      });
      throw new NotFoundException('No project media found');
    }

    try {
      await this.assertAccess(media, userId, userType);
    } catch (error) {
      await this.recordLog({
        userId,
        dto,
        status: 'denied',
        errorCode: 'INSUFFICIENT_PERMISSION',
        metadata,
      });
      throw error;
    }

    if (dto.scope === 'single') {
      if (media.length !== 1) {
        throw new BadRequestException('Single download requires exactly one media item');
      }
      return this.createSingle(media[0], dto, userId, metadata);
    }

    const normalizedKey = idempotencyKey?.trim().slice(0, 255);
    if (normalizedKey) {
      const existing = await this.dataSource.query(
        `SELECT id FROM download_jobs
         WHERE external_user_id = $1 AND idempotency_key = $2
         LIMIT 1`,
        [userId, normalizedKey],
      );
      if (existing[0]?.id) {
        return this.get(existing[0].id, userId);
      }
    }

    const job = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(DownloadJobEntity, {
          id: uuidv7(),
          externalUserId: userId,
          projectId: dto.projectId ?? null,
          scope: dto.scope,
          downloadType: dto.downloadType,
          status: 'queued',
          totalItems: media.length,
          completedItems: 0,
          zipBucket: null,
          zipStorageKey: null,
          zipSizeBytes: null,
          expiresAt: null,
          errorMessage: null,
          queueJobId: null,
          idempotencyKey: normalizedKey,
        }),
      );
      await manager.insert(
        DownloadJobItemEntity,
        media.map((item) => ({
          id: uuidv7(),
          downloadJobId: saved.id,
          projectMediaId: item.id,
          assetId: item.assetId,
          status: 'queued' as const,
          errorMessage: null,
        })),
      );
      return saved;
    });
    await this.recordLog({
      userId,
      dto,
      status: 'started',
      downloadJobId: job.id,
      metadata,
    });
    await this.downloadQueue.addJob({ jobId: job.id, userId });
    return {
      mode: 'job',
      downloadJobId: job.id,
      status: job.status,
      totalItems: job.totalItems,
    };
  }

  async get(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const job = await this.jobRepository.findOne({
      where: isAdminUserType(userType) ? { id } : { id, externalUserId: userId },
    });
    if (!job) {
      throw new NotFoundException('Download job not found');
    }
    if (job.expiresAt && job.expiresAt.getTime() <= Date.now() && job.status !== 'expired') {
      await this.jobRepository.update(id, { status: 'expired' });
      job.status = 'expired';
    }
    let url: string | null = null;
    if (job.status === 'completed' && job.zipStorageKey) {
      const ttl = this.config.getOrThrow<number>('R2_PRESIGNED_URL_TTL_SECONDS');
      url = await this.storage.getPresignedGetUrl(job.zipStorageKey, 'application/zip', ttl);
    }
    const [enrichedJob] = await this.actorEnrichment.enrich(
      [job as unknown as Record<string, unknown>],
      [{ id: 'externalUserId', target: 'actorUser' }],
    );
    return { ...enrichedJob, url };
  }

  async cancel(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const job = await this.jobRepository.findOne({
      where: isAdminUserType(userType) ? { id } : { id, externalUserId: userId },
    });
    if (!job) {
      throw new NotFoundException('Download job not found');
    }
    if (['completed', 'failed', 'expired', 'cancelled'].includes(job.status)) {
      return job;
    }
    await this.jobRepository.update(id, { status: 'cancelled' });
    return this.jobRepository.findOneOrFail({ where: { id } });
  }

  private async createSingle(
    media: ProjectMediaEntity,
    dto: CreateDownloadDto,
    userId: string,
    metadata: RequestMetadata,
  ) {
    const asset = await this.assetRepository.findOne({ where: { id: media.assetId } });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    const target =
      dto.downloadType === 'original'
        ? {
            key: asset.originalStorageKey,
            mimeType: asset.mimeType,
            size: asset.fileSizeBytes,
          }
        : await this.resolveRenderedVariant(asset.id);
    const ttl = this.config.getOrThrow<number>('R2_PRESIGNED_URL_TTL_SECONDS');
    const url = await this.storage.getPresignedGetUrl(target.key, target.mimeType, ttl);
    const log = await this.recordLog({
      userId,
      dto,
      status: 'started',
      projectId: media.projectId,
      projectMediaId: media.id,
      assetId: asset.id,
      metadata,
    });
    return {
      mode: 'single',
      url,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      downloadLogId: log.id,
      fileSizeBytes: target.size,
      mimeType: target.mimeType,
    };
  }

  private async resolveMedia(dto: CreateDownloadDto): Promise<ProjectMediaEntity[]> {
    if (dto.scope === 'single' || dto.scope === 'multiple') {
      if (!dto.projectMediaIds?.length) {
        throw new BadRequestException('projectMediaIds is required');
      }
      return this.mediaRepository.findBy({ id: In([...new Set(dto.projectMediaIds)]) });
    }
    if (!dto.projectId) {
      throw new BadRequestException('projectId is required for project download');
    }
    return this.mediaRepository.findBy({ projectId: dto.projectId });
  }

  private async assertAccess(
    media: ProjectMediaEntity[],
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    const projects = await this.projectRepository.findBy({
      id: In([...new Set(media.map((item) => item.projectId))]),
    });
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    for (const item of media) {
      const project = projectsById.get(item.projectId);
      if (
        !project ||
        !(await this.folderAccess.canAccess(project.folderId, userId, 'viewer', userType))
      ) {
        throw new ForbiddenException('Insufficient download folder permission');
      }
    }
  }

  private async resolveRenderedVariant(assetId: string) {
    const variant = await findRenderedVariant(
      this.variantRepository,
      this.profileRepository,
      assetId,
    );
    if (!variant) {
      throw new ConflictException('Rendered variant is not ready');
    }
    return {
      key: variant.storageKey,
      mimeType: variant.mimeType,
      size: variant.fileSizeBytes,
    };
  }

  private async recordLog(input: {
    userId: string;
    dto: CreateDownloadDto;
    status: 'started' | 'completed' | 'failed' | 'denied';
    errorCode?: string;
    projectId?: string;
    projectMediaId?: string;
    assetId?: string;
    downloadJobId?: string;
    metadata: RequestMetadata;
  }) {
    return this.logRepository.save(
      this.logRepository.create({
        externalUserId: input.userId,
        projectId: input.projectId ?? input.dto.projectId ?? null,
        projectMediaId: input.projectMediaId ?? null,
        assetId: input.assetId ?? null,
        downloadJobId: input.downloadJobId ?? null,
        scope: input.dto.scope,
        downloadType: input.dto.downloadType,
        status: input.status,
        fileSizeBytes: null,
        ipAddress: input.metadata.ipAddress ?? null,
        userAgent: input.metadata.userAgent ?? null,
        errorCode: input.errorCode ?? null,
        completedAt: null,
      }),
    );
  }
}
