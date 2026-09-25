import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { Response } from 'express';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { isAdminUserType } from '../../common/auth/user-type';
import { OutboxService } from '../../common/outbox.service';
import { AssetUploadSessionEntity } from '../../database/entities/asset-upload-session.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { FolderAccessLevel, FolderAccessService } from '../folders/folder-access.service';
import { deriveProjectEvaluationStatus } from '../media/evaluation-status';
import { isPreviewVariantCode, pickPreviewVariant } from '../render/render-sizes';
import {
  findActiveRenderProfile,
  isVariantServable,
  WATERMARK_LOGO_PURPOSE,
} from '../render/watermark-policy';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateUploadSessionDto } from './dto/create-upload-session.dto';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage/storage-adapter';

@Injectable()
export class AssetsService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetUploadSessionEntity)
    private readonly sessionRepository: Repository<AssetUploadSessionEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepository: Repository<AssetVariantEntity>,
    @InjectRepository(ProjectMediaEntity)
    private readonly projectMediaRepository: Repository<ProjectMediaEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    @InjectRepository(RenderProfileEntity)
    private readonly renderProfileRepository: Repository<RenderProfileEntity>,
    private readonly folderAccessService: FolderAccessService,
    private readonly config: ConfigService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly outboxService: OutboxService,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, 60_000);
    this.cleanupTimer.unref();
    void this.cleanupExpiredSessions();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  async createUploadSession(
    dto: CreateUploadSessionDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    idempotencyKey?: string,
  ) {
    this.ensureUploadSize(dto.fileSizeBytes);
    const project = await this.getProject(dto.targetProjectId);
    await this.requireProjectAccess(project, userId, 'editor', userType);
    return this.openUploadSession(
      dto,
      userId,
      { targetProjectId: project.id, keyPrefix: `projects/${project.id}/originals` },
      idempotencyKey,
    );
  }

  /**
   * Upload session for the watermark logo. The logo is a global setting: it is not attached to
   * any project and is stored as-is, without render variants.
   */
  async createWatermarkLogoUploadSession(
    dto: Omit<CreateUploadSessionDto, 'assetType' | 'targetProjectId'>,
    userId: string,
  ) {
    this.ensureUploadSize(dto.fileSizeBytes);
    return this.openUploadSession({ ...dto, assetType: 'image' }, userId, {
      targetProjectId: null,
      keyPrefix: 'settings/watermark',
      sourceMetadata: { purpose: WATERMARK_LOGO_PURPOSE },
    });
  }

  private ensureUploadSize(fileSizeBytes: number) {
    const maxUploadBytes = this.config.getOrThrow<number>('MAX_UPLOAD_SIZE_BYTES');
    if (fileSizeBytes > maxUploadBytes) {
      throw new BadRequestException(`File exceeds the ${maxUploadBytes} byte upload limit`);
    }
  }

  private async openUploadSession(
    dto: Omit<CreateUploadSessionDto, 'targetProjectId'>,
    userId: string,
    target: {
      targetProjectId: string | null;
      keyPrefix: string;
      sourceMetadata?: Record<string, unknown>;
    },
    idempotencyKey?: string,
  ) {
    const normalizedIdempotencyKey = idempotencyKey?.trim().slice(0, 255);
    if (normalizedIdempotencyKey) {
      const existing = await this.sessionRepository.findOne({
        where: { createdBy: userId, idempotencyKey: normalizedIdempotencyKey },
        relations: { asset: true },
      });
      if (existing) {
        if (existing.status === 'expired' || existing.status === 'aborted') {
          throw new ConflictException('The idempotency key belongs to a closed upload session');
        }
        return this.toUploadSessionResponse(existing);
      }
    }

    const assetId = uuidv7();
    const sessionId = uuidv7();
    const bucketName = this.config.getOrThrow<string>('R2_BUCKET');
    const extension = this.normalizeExtension(dto.extension, dto.originalFilename, dto.mimeType);
    const originalFilename = this.ensureFilenameExtension(dto.originalFilename.trim(), extension);
    const storageKey = `${target.keyPrefix}/${assetId}${extension ? `.${extension}` : ''}`;
    const expiresAt = new Date(
      Date.now() + this.config.getOrThrow<number>('UPLOAD_SESSION_TTL_SECONDS') * 1000,
    );

    const session = await this.dataSource.transaction(async (manager) => {
      const asset = manager.create(AssetEntity, {
        id: assetId,
        assetType: dto.assetType,
        originalFilename,
        extension: extension || null,
        mimeType: dto.mimeType.trim(),
        checksumSha256: null,
        fileSizeBytes: String(dto.fileSizeBytes),
        storageProvider: 'r2',
        originalBucket: bucketName,
        originalStorageKey: storageKey,
        processingStatus: 'uploading',
        processingError: null,
        sourceType: 'local',
        sourceMetadata: target.sourceMetadata ?? {},
        createdBy: userId,
      });
      await manager.save(asset);
      return manager.save(
        manager.create(AssetUploadSessionEntity, {
          id: sessionId,
          assetId,
          targetProjectId: target.targetProjectId,
          storageProvider: asset.storageProvider,
          bucketName,
          storageKey,
          multipartUploadId: null,
          expectedSizeBytes: String(dto.fileSizeBytes),
          expectedChecksumSha256: dto.expectedChecksumSha256?.toLowerCase() ?? null,
          idempotencyKey: normalizedIdempotencyKey ?? null,
          status: 'initiated',
          expiresAt,
          completedAt: null,
          createdBy: userId,
        }),
      );
    });

    return this.toUploadSessionResponse(session, dto.mimeType);
  }

  async completeUpload(
    assetId: string,
    dto: CompleteUploadDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ) {
    const session = await this.sessionRepository.findOne({
      where: isAdminUserType(userType)
        ? { id: dto.uploadSessionId }
        : { id: dto.uploadSessionId, createdBy: userId },
    });
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (session.assetId !== assetId) {
      throw new BadRequestException('Upload session does not belong to this asset');
    }
    if (session.status === 'completed') {
      return {
        ...(await this.getAsset(session.assetId)),
        uploadSessionId: session.id,
        projectMediaId: await this.findSessionProjectMediaId(session),
      };
    }
    this.ensureSessionOpen(session);

    const head = await this.storage.headObject(session.storageKey);
    if (!head) {
      throw new ConflictException('Uploaded object was not found');
    }
    if (session.expectedSizeBytes && Number(session.expectedSizeBytes) !== head.sizeBytes) {
      throw new BadRequestException('Uploaded object size does not match the declared size');
    }
    const expectedChecksum = dto.checksumSha256?.toLowerCase() ?? session.expectedChecksumSha256;
    if (expectedChecksum && expectedChecksum !== head.checksumSha256) {
      throw new BadRequestException('Uploaded object checksum does not match');
    }
    const asset = await this.getAsset(session.assetId);
    // The watermark logo is used as-is by the renderer; it must not be watermarked itself.
    const isWatermarkLogo = asset.sourceMetadata?.purpose === WATERMARK_LOGO_PURPOSE;
    const profile = isWatermarkLogo
      ? null
      : await findActiveRenderProfile(this.renderProfileRepository);

    let renderJobId: string | null = null;
    let outboxEventId: string | null = null;
    let projectMediaId: string | null = null;
    await this.dataSource.transaction(async (manager) => {
      await manager.update(AssetEntity, session.assetId, {
        checksumSha256: head.checksumSha256 ?? expectedChecksum ?? null,
        processingStatus: isWatermarkLogo ? 'ready' : 'uploaded',
      });
      await manager.update(AssetUploadSessionEntity, session.id, {
        status: 'completed',
        completedAt: new Date(),
      });
      if (session.targetProjectId) {
        const existingMedia = await manager.findOne(ProjectMediaEntity, {
          where: { projectId: session.targetProjectId, assetId: session.assetId },
        });
        projectMediaId = existingMedia?.id ?? uuidv7();
        if (!existingMedia) {
          await manager.insert(ProjectMediaEntity, {
            id: projectMediaId,
            projectId: session.targetProjectId,
            assetId: session.assetId,
            sortOrder: 0,
            caption: null,
            createdBy: userId,
          });
          await this.refreshProjectCounters(manager, session.targetProjectId);
        }
      }
      if (isWatermarkLogo) {
        return;
      }
      const dedupeKey = `${session.assetId}:system:${profile?.id ?? 'legacy'}:${profile?.profileVersion ?? 1}`;
      const activeJob = await manager
        .createQueryBuilder(MediaRenderJobEntity, 'job')
        .where('job.dedupe_key = :dedupeKey', { dedupeKey })
        .andWhere('job.status IN (:...statuses)', { statuses: ['queued', 'processing'] })
        .getOne();
      const job =
        activeJob ??
        (await manager.save(
          manager.create(MediaRenderJobEntity, {
            id: uuidv7(),
            assetId: session.assetId,
            renderProfileId: profile?.id ?? null,
            renderVersion: profile?.profileVersion ?? 1,
            queueJobId: null,
            dedupeKey,
            status: 'queued',
            progressPercent: 0,
            progressMessage: 'Queued for media processing',
            attemptCount: 0,
            errorCode: null,
            errorMessage: null,
            startedAt: null,
            finishedAt: null,
            createdBy: userId,
          }),
        ));
      renderJobId = job.id;
      if (!activeJob) {
        const event = this.outboxService.create(manager, {
          eventType: 'asset.processing.requested',
          aggregateType: 'asset',
          aggregateId: session.assetId,
          payload: {
            assetId: session.assetId,
            renderJobId: job.id,
            userId,
          },
        });
        const savedEvent = await manager.save(event);
        outboxEventId = savedEvent.id;
      }
    });
    return {
      ...(await this.getAsset(session.assetId)),
      uploadSessionId: session.id,
      renderJobId,
      outboxEventId,
      projectMediaId,
    };
  }

  async abortUpload(
    assetId: string,
    uploadSessionId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ) {
    const session = await this.sessionRepository.findOne({
      where: isAdminUserType(userType)
        ? { id: uploadSessionId }
        : { id: uploadSessionId, createdBy: userId },
    });
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    if (session.assetId !== assetId) {
      throw new BadRequestException('Upload session does not belong to this asset');
    }
    if (session.status === 'completed') {
      throw new ConflictException('Completed upload cannot be aborted');
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(AssetUploadSessionEntity, session.id, { status: 'aborted' });
      await manager.update(AssetEntity, session.assetId, { processingStatus: 'cancelled' });
    });
    await this.storage.deleteObject(session.storageKey);
    return { success: true };
  }

  async listVariants(assetId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    await this.requireAssetAccess(assetId, userId, 'viewer', userType);
    return this.variantRepository.find({
      where: { assetId },
      order: { variantCode: 'ASC' },
    });
  }

  async preview(
    assetId: string,
    variantCode: string,
    userId: string,
    userType: 'ADMIN' | 'USER' | undefined,
    response: Response,
    width?: number,
  ) {
    await this.requireAssetAccess(assetId, userId, 'viewer', userType);
    const variant = await this.findReadyVariant(assetId, variantCode, width);
    response.setHeader('Content-Type', variant.mimeType);
    response.setHeader('Content-Length', variant.fileSizeBytes);
    this.storage.readObject(variant.storageKey).pipe(response);
  }

  async getPreviewUrl(
    assetId: string,
    variantCode: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    width?: number,
  ) {
    await this.requireAssetAccess(assetId, userId, 'viewer', userType);
    const variant = await this.findReadyVariant(assetId, variantCode, width);
    const expiresInSeconds = this.config.getOrThrow<number>('R2_PRESIGNED_URL_TTL_SECONDS');
    const url = await this.storage.getPresignedGetUrl(
      variant.storageKey,
      variant.mimeType,
      expiresInSeconds,
    );

    return {
      url,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      variantCode: variant.variantCode,
      mimeType: variant.mimeType,
      fileSizeBytes: variant.fileSizeBytes,
      width: variant.width,
      height: variant.height,
    };
  }

  /**
   * Presigned URL of the original, un-watermarked file, for evaluating media at full quality.
   * Only for users allowed to evaluate or download originals (enforced by the controller).
   */
  async getOriginalUrl(assetId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const asset = await this.requireAssetAccess(assetId, userId, 'viewer', userType);
    const expiresInSeconds = this.config.getOrThrow<number>('R2_PRESIGNED_URL_TTL_SECONDS');
    return {
      url: await this.storage.getPresignedGetUrl(
        asset.originalStorageKey,
        asset.mimeType,
        expiresInSeconds,
      ),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      mimeType: asset.mimeType,
      fileSizeBytes: asset.fileSizeBytes,
    };
  }

  /** Preview sizes a viewer may choose from, smallest first. */
  async listRenditions(assetId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    await this.requireAssetAccess(assetId, userId, 'viewer', userType);
    const previews = await this.findServablePreviews(assetId);
    return previews
      .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))
      .map((variant) => ({
        variantCode: variant.variantCode,
        width: variant.width,
        height: variant.height,
        mimeType: variant.mimeType,
      }));
  }

  async retry(assetId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    await this.requireAssetAccess(assetId, userId, 'editor', userType);
    const profile = await findActiveRenderProfile(this.renderProfileRepository);
    return this.dataSource.transaction(async (manager) => {
      const job = await manager.save(
        manager.create(MediaRenderJobEntity, {
          id: uuidv7(),
          assetId,
          renderProfileId: profile?.id ?? null,
          renderVersion: profile?.profileVersion ?? 1,
          queueJobId: null,
          dedupeKey: `${assetId}:retry:${profile?.id ?? 'legacy'}:${profile?.profileVersion ?? 1}:${uuidv7()}`,
          status: 'queued',
          progressPercent: 0,
          progressMessage: 'Queued for media processing retry',
          attemptCount: 0,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          createdBy: userId,
        }),
      );
      const event = await manager.save(
        this.outboxService.create(manager, {
          eventType: 'asset.processing.requested',
          aggregateType: 'asset',
          aggregateId: assetId,
          payload: { assetId, renderJobId: job.id, userId },
        }),
      );
      return { ...job, outboxEventId: event.id };
    });
  }

  async cleanupExpiredSessions() {
    const expired = await this.sessionRepository.find({
      where: { status: In(['initiated', 'uploading']) },
    });
    const now = Date.now();
    for (const session of expired) {
      if (session.expiresAt.getTime() >= now) {
        continue;
      }
      await this.sessionRepository.update(session.id, { status: 'expired' });
      await this.assetRepository.update(session.assetId, { processingStatus: 'cancelled' });
      await this.storage.deleteObject(session.storageKey);
    }
    return expired.filter((session) => session.expiresAt.getTime() < now).length;
  }

  async getAsset(assetId: string): Promise<AssetEntity> {
    const asset = await this.assetRepository.findOne({ where: { id: assetId } });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    return asset;
  }

  private async requireAssetAccess(
    assetId: string,
    userId: string,
    minimum: FolderAccessLevel,
    userType?: 'ADMIN' | 'USER',
  ) {
    const asset = await this.getAsset(assetId);
    if (isAdminUserType(userType) || asset.createdBy === userId) {
      return asset;
    }
    const projects = await this.projectRepository
      .createQueryBuilder('project')
      .innerJoin(ProjectMediaEntity, 'media', 'media.project_id = project.id')
      .where('media.asset_id = :assetId', { assetId })
      .getMany();
    for (const project of projects) {
      if (await this.folderAccessService.canAccess(project.folderId, userId, minimum, userType)) {
        return asset;
      }
    }
    throw new ForbiddenException('Insufficient asset permission');
  }

  /**
   * `preview` is an alias for "the best preview for a frame `width` pixels wide" (the largest
   * without a width); any other code is looked up as is.
   */
  private async findReadyVariant(assetId: string, variantCode: string, width?: number) {
    if (variantCode === 'preview') {
      const variant = pickPreviewVariant(await this.findServablePreviews(assetId), width);
      if (!variant) {
        throw new NotFoundException('Ready watermarked asset variant not found');
      }
      return variant;
    }
    const [variant, profile] = await Promise.all([
      this.variantRepository.findOne({ where: { assetId, variantCode, status: 'ready' } }),
      findActiveRenderProfile(this.renderProfileRepository),
    ]);
    if (!variant || !isVariantServable(variant, profile)) {
      throw new NotFoundException('Ready watermarked asset variant not found');
    }
    return variant;
  }

  private async findServablePreviews(assetId: string) {
    const [variants, profile] = await Promise.all([
      this.variantRepository.find({ where: { assetId, status: 'ready' } }),
      findActiveRenderProfile(this.renderProfileRepository),
    ]);
    return variants.filter(
      (variant) => isPreviewVariantCode(variant.variantCode) && isVariantServable(variant, profile),
    );
  }

  private async findSessionProjectMediaId(session: AssetUploadSessionEntity) {
    if (!session.targetProjectId) {
      return null;
    }
    const media = await this.projectMediaRepository.findOne({
      where: { projectId: session.targetProjectId, assetId: session.assetId },
    });
    return media?.id ?? null;
  }

  /** Presigned URL of the watermark logo original, for the settings page. */
  async getWatermarkLogoUrl(assetId: string) {
    const asset = await this.getAsset(assetId);
    const isLogo =
      asset.sourceMetadata?.purpose === WATERMARK_LOGO_PURPOSE ||
      (await this.renderProfileRepository
        .createQueryBuilder('profile')
        .where("profile.watermark_config ->> 'logoAssetId' = :assetId", { assetId })
        .getExists());
    if (asset.assetType !== 'image' || !isLogo) {
      throw new NotFoundException('Watermark logo not found');
    }
    const expiresInSeconds = this.config.getOrThrow<number>('R2_PRESIGNED_URL_TTL_SECONDS');
    return {
      url: await this.storage.getPresignedGetUrl(
        asset.originalStorageKey,
        asset.mimeType,
        expiresInSeconds,
      ),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  private async getProject(projectId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }

  private async requireProjectAccess(
    project: ProjectEntity,
    userId: string,
    minimum: FolderAccessLevel,
    userType?: 'ADMIN' | 'USER',
  ) {
    const allowed = await this.folderAccessService.canAccess(
      project.folderId,
      userId,
      minimum,
      userType,
    );
    if (!allowed) {
      throw new ForbiddenException('Insufficient project permission');
    }
  }

  private ensureSessionOpen(session: AssetUploadSessionEntity) {
    if (session.expiresAt.getTime() < Date.now()) {
      void this.sessionRepository.update(session.id, { status: 'expired' });
      throw new ConflictException('Upload session has expired');
    }
    if (session.status === 'aborted' || session.status === 'expired') {
      throw new ConflictException('Upload session is closed');
    }
  }

  private async toUploadSessionResponse(session: AssetUploadSessionEntity, contentType?: string) {
    const expiresInSeconds = Math.max(
      1,
      Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
    );
    return {
      assetId: session.assetId,
      uploadSessionId: session.id,
      storageProvider: session.storageProvider,
      storageKey: session.storageKey,
      uploadUrl: await this.storage.getPresignedPutUrl(
        session.storageKey,
        session.asset?.mimeType ?? contentType ?? 'application/octet-stream',
        Math.min(expiresInSeconds, this.config.getOrThrow<number>('R2_PRESIGNED_URL_TTL_SECONDS')),
      ),
      expiresAt: session.expiresAt,
      status: session.status,
    };
  }

  private normalizeExtension(
    extension: string | undefined,
    filename: string,
    mimeType?: string,
  ): string {
    const filenameExtension =
      !extension && filename.lastIndexOf('.') > 0
        ? filename.slice(filename.lastIndexOf('.') + 1)
        : '';
    const value = extension || filenameExtension || this.extensionFromMimeType(mimeType);
    return value
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase()
      .slice(0, 20);
  }

  private extensionFromMimeType(mimeType?: string): string {
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/quicktime': 'mp4',
      'video/webm': 'webm',
      'video/x-matroska': 'mkv',
    };
    return map[mimeType?.toLowerCase() ?? ''] ?? '';
  }

  private ensureFilenameExtension(filename: string, extension: string): string {
    return extension && filename.lastIndexOf('.') <= 0 ? `${filename}.${extension}` : filename;
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
    const counts = await manager
      .createQueryBuilder(ProjectMediaEntity, 'media')
      .select('COUNT(*)', 'total')
      .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'pending')", 'pending')
      .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'approved')", 'approved')
      .addSelect("COUNT(*) FILTER (WHERE media.evaluation_status = 'rejected')", 'rejected')
      .where('media.project_id = :projectId', { projectId })
      .getRawOne<{ total: string; pending: string; approved: string; rejected: string }>();
    const pending = Number(counts?.pending ?? 0);
    const approved = Number(counts?.approved ?? 0);
    const rejected = Number(counts?.rejected ?? 0);
    const evaluationStatus = deriveProjectEvaluationStatus(totalMedia, pending, approved, rejected);
    await manager.update(ProjectEntity, projectId, { evaluationStatus });
    await manager.query(
      `INSERT INTO project_evaluation_summaries
        (project_id, total_media, pending_count, approved_count, rejected_count, evaluation_status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id) DO UPDATE SET
        total_media = EXCLUDED.total_media,
        pending_count = EXCLUDED.pending_count,
        approved_count = EXCLUDED.approved_count,
        rejected_count = EXCLUDED.rejected_count,
        evaluation_status = EXCLUDED.evaluation_status,
        calculated_at = now(),
        updated_at = now()`,
      [projectId, totalMedia, pending, approved, rejected, evaluationStatus],
    );
  }
}
