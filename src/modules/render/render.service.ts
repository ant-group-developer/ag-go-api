import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import {
  cancelSupersededRenderJobs,
  hasNewerRenderJob,
  refreshRenderBatch,
} from './render-job-lifecycle';
import { normalizePreviewWidths, PREVIEW_VARIANT_SQL } from './render-sizes';
import { normalizeWatermarkConfig } from './watermark-config';

const AUTO_JOBS_DEFAULT_PAGE_SIZE = 20;
const AUTO_JOBS_MAX_PAGE_SIZE = 100;
const ACTIVE_JOB_STATUSES = ['queued', 'processing'];

/** Status tabs of the auto render job list; 'active' groups queued and processing jobs. */
export const AUTO_JOB_STATUS_FILTERS = [
  'all',
  'active',
  'completed',
  'failed',
  'cancelled',
] as const;
export type AutoJobStatusFilter = (typeof AUTO_JOB_STATUS_FILTERS)[number];

export function isAutoJobStatusFilter(value: unknown): value is AutoJobStatusFilter {
  return AUTO_JOB_STATUS_FILTERS.includes(value as AutoJobStatusFilter);
}

export type AutoJobCounts = Record<AutoJobStatusFilter, number>;

/**
 * Sortable columns of the auto render job list: when the job was queued, when processing
 * started, and how long processing took (finished - started).
 */
export const AUTO_JOB_SORT_FIELDS = ['createdAt', 'startedAt', 'elapsed'] as const;
export type AutoJobSortField = (typeof AUTO_JOB_SORT_FIELDS)[number];
export type AutoJobSortOrder = 'ASC' | 'DESC';

export function isAutoJobSortField(value: unknown): value is AutoJobSortField {
  return AUTO_JOB_SORT_FIELDS.includes(value as AutoJobSortField);
}

/** SQL expression per sort field; jobs not started / not finished yet sort last either way. */
const AUTO_JOB_SORT_EXPRESSIONS: Record<AutoJobSortField, string> = {
  createdAt: 'job.created_at',
  startedAt: 'job.started_at',
  elapsed: '(job.finished_at - job.started_at)',
};

export type RenderJobSource = 'batch' | 'upload' | 'import' | 'retry' | 'other';

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
    private readonly config: ConfigService,
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
          renderSizes:
            dto.renderSizes === undefined
              ? latest.renderSizes
              : {
                  previewWidths: normalizePreviewWidths(dto.renderSizes.previewWidths),
                  thumbnailWidth: dto.renderSizes.thumbnailWidth,
                },
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

      const newJobs = jobsToQueue.map((item) => ({
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
      }));
      await manager.insert(MediaRenderJobEntity, newJobs);
      // Only this profile's render may still run for these files: an older profile's job
      // finishing later would overwrite the new previews.
      await cancelSupersededRenderJobs(
        manager,
        media.map((item) => item.assetId),
        [
          ...newJobs.map((job) => job.id),
          ...existingJobs.filter((job) => job.status !== 'completed').map((job) => job.id),
        ],
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
      // Any ready preview without a watermark (or no ready preview at all) needs a re-render.
      // Thumbnails are never watermarked, so they are ignored here.
      mediaQuery.andWhere(
        `(EXISTS (
          SELECT 1 FROM asset_variants av
          WHERE av.asset_id = media.asset_id
            AND av.status = 'ready'
            AND ${PREVIEW_VARIANT_SQL}
            AND av.has_watermark = false
        ) OR NOT EXISTS (
          SELECT 1 FROM asset_variants av
          WHERE av.asset_id = media.asset_id
            AND av.status = 'ready'
            AND ${PREVIEW_VARIANT_SQL}
        ))`,
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
    return this.enrichBatches(
      await this.batchRepository.find({
        where: { projectId },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
    );
  }

  async listAllBatches(userId: string, userType?: 'ADMIN' | 'USER') {
    const batches = await this.batchRepository.find({
      order: { createdAt: 'DESC' },
    });
    if (isAdminUserType(userType)) {
      return this.enrichBatches(batches);
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
    return this.enrichBatches(visible);
  }

  /**
   * Adds what the render history table shows: the project (or how many projects a batch spans),
   * the folder, the render profile and who started the batch.
   */
  private async enrichBatches(batches: RenderBatchEntity[]) {
    if (batches.length === 0) {
      return [];
    }
    const batchIds = batches.map((batch) => batch.id);
    const [projectSummaries, folders, profiles] = await Promise.all([
      this.dataSource.query(
        `SELECT job.render_batch_id AS "batchId",
                COUNT(DISTINCT media.project_id)::int AS "projectCount",
                MIN(project.name) AS "projectName"
         FROM media_render_jobs job
         INNER JOIN project_media media ON media.asset_id = job.asset_id
         INNER JOIN projects project ON project.id = media.project_id
         WHERE job.render_batch_id = ANY($1::uuid[])
         GROUP BY job.render_batch_id`,
        [batchIds],
      ) as Promise<Array<{ batchId: string; projectCount: number; projectName: string | null }>>,
      this.dataSource.query(
        `SELECT id, path_text AS "pathText" FROM folders WHERE id = ANY($1::uuid[])`,
        [[...new Set(batches.flatMap((batch) => (batch.folderId ? [batch.folderId] : [])))]],
      ) as Promise<Array<{ id: string; pathText: string }>>,
      this.profileRepository.findBy({
        id: In([...new Set(batches.map((batch) => batch.renderProfileId))]),
      }),
    ]);
    const summaryByBatch = new Map(projectSummaries.map((row) => [row.batchId, row]));
    const folderById = new Map(folders.map((folder) => [folder.id, folder.pathText]));
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    return this.actorEnrichment.enrich(
      batches.map((batch) => {
        const summary = summaryByBatch.get(batch.id);
        const profile = profileById.get(batch.renderProfileId);
        return {
          ...batch,
          projectName: summary?.projectName ?? null,
          projectCount: summary?.projectCount ?? 0,
          folderPath: batch.folderId ? (folderById.get(batch.folderId) ?? null) : null,
          profileName: profile?.name ?? null,
          profileVersion: profile?.profileVersion ?? null,
        };
      }) as unknown as Array<Record<string, unknown>>,
      [{ id: 'createdBy', target: 'createdByUser' }],
    );
  }

  /** Jobs of a batch, described by {@link describeJobs}. */
  async listJobs(batchId: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const batch = await this.getBatch(batchId, userId, userType);
    const jobs = await this.jobRepository.find({
      where: { renderBatchId: batch.id },
      order: { createdAt: 'ASC' },
    });
    return this.describeJobs(jobs);
  }

  /**
   * Jobs queued automatically outside any batch: after an upload, a Google Drive import or a
   * per-file retry. Newest first unless `sortBy` / `sortOrder` say otherwise, one page at a time;
   * non-admins only see jobs of projects they can view. `counts` ignores the status filter (but
   * not the search) so every tab shows its size.
   */
  async listAutoJobs(
    userId: string,
    userType?: 'ADMIN' | 'USER',
    options: {
      projectId?: string;
      page?: number;
      pageSize?: number;
      status?: AutoJobStatusFilter;
      search?: string;
      sortBy?: AutoJobSortField;
      sortOrder?: AutoJobSortOrder;
    } = {},
  ) {
    const page = Math.max(Math.trunc(options.page ?? 1) || 1, 1);
    const pageSize = Math.min(
      Math.max(Math.trunc(options.pageSize ?? AUTO_JOBS_DEFAULT_PAGE_SIZE) || 1, 1),
      AUTO_JOBS_MAX_PAGE_SIZE,
    );
    const status = options.status ?? 'all';
    const emptyCounts: AutoJobCounts = { all: 0, active: 0, completed: 0, failed: 0, cancelled: 0 };
    const query = this.jobRepository.createQueryBuilder('job').where('job.render_batch_id IS NULL');

    if (options.projectId) {
      const project = await this.projectRepository.findOne({ where: { id: options.projectId } });
      if (
        !project ||
        !(await this.folderAccess.canAccess(project.folderId, userId, 'viewer', userType))
      ) {
        throw new ForbiddenException('Insufficient project permission');
      }
      query.andWhere(
        `EXISTS (SELECT 1 FROM project_media media
                 WHERE media.asset_id = job.asset_id AND media.project_id = :projectId)`,
        { projectId: project.id },
      );
    } else if (!isAdminUserType(userType)) {
      const folderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
      if (folderIds.length === 0) {
        return { items: [], total: 0, page, pageSize, counts: emptyCounts };
      }
      query.andWhere(
        `EXISTS (SELECT 1 FROM project_media media
                 INNER JOIN projects project ON project.id = media.project_id
                 WHERE media.asset_id = job.asset_id AND project.folder_id IN (:...folderIds))`,
        { folderIds },
      );
    }

    const search = options.search?.trim();
    if (search) {
      // Matches the file name or the name of any project the file belongs to.
      query.andWhere(
        `(EXISTS (SELECT 1 FROM assets search_asset
                  WHERE search_asset.id = job.asset_id
                    AND search_asset.original_filename ILIKE :search ESCAPE '!')
          OR EXISTS (SELECT 1 FROM project_media search_media
                     INNER JOIN projects search_project ON search_project.id = search_media.project_id
                     WHERE search_media.asset_id = job.asset_id
                       AND search_project.name ILIKE :search ESCAPE '!'))`,
        // '!' escapes LIKE wildcards typed by the user so they match literally.
        { search: `%${search.replace(/[!%_]/g, (char) => `!${char}`)}%` },
      );
    }

    const countRow = await query
      .clone()
      .select('COUNT(*)::int', 'all')
      .addSelect(`COUNT(*) FILTER (WHERE job.status IN ('queued', 'processing'))::int`, 'active')
      .addSelect(`COUNT(*) FILTER (WHERE job.status = 'completed')::int`, 'completed')
      .addSelect(`COUNT(*) FILTER (WHERE job.status = 'failed')::int`, 'failed')
      .addSelect(`COUNT(*) FILTER (WHERE job.status = 'cancelled')::int`, 'cancelled')
      .getRawOne<AutoJobCounts>();
    const counts = countRow ?? emptyCounts;

    if (status === 'active') {
      query.andWhere('job.status IN (:...activeStatuses)', {
        activeStatuses: ACTIVE_JOB_STATUSES,
      });
    } else if (status !== 'all') {
      query.andWhere('job.status = :status', { status });
    }
    const sortBy = options.sortBy ?? 'createdAt';
    const sortOrder = options.sortOrder ?? 'DESC';
    query.orderBy(AUTO_JOB_SORT_EXPRESSIONS[sortBy], sortOrder, 'NULLS LAST');
    if (sortBy !== 'createdAt') {
      // Ties (e.g. every queued job has no start time) fall back to newest first.
      query.addOrderBy('job.created_at', 'DESC');
    }
    const jobs = await query
      .addOrderBy('job.id', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getMany();
    return {
      items: await this.describeJobs(jobs),
      total: counts[status],
      page,
      pageSize,
      counts,
    };
  }

  /**
   * Adds the source file (name, size, resolution), its project, the variants it currently has,
   * what queued the job and who did, so the UI can compare the original with the rendered outputs.
   */
  private async describeJobs(jobs: MediaRenderJobEntity[]) {
    const assetIds = [...new Set(jobs.map((job) => job.assetId))];
    if (assetIds.length === 0) {
      return [];
    }
    const [assets, variants, projects] = await Promise.all([
      this.assetRepository.findBy({ id: In(assetIds) }),
      this.dataSource.getRepository(AssetVariantEntity).find({
        where: { assetId: In(assetIds), status: 'ready' },
        order: { width: 'ASC' },
      }),
      this.dataSource.query(
        `SELECT DISTINCT ON (media.asset_id)
                media.asset_id AS "assetId", project.id, project.name
         FROM project_media media
         INNER JOIN projects project ON project.id = media.project_id
         WHERE media.asset_id = ANY($1::uuid[])
         ORDER BY media.asset_id, media.created_at ASC`,
        [assetIds],
      ) as Promise<Array<{ assetId: string; id: string; name: string }>>,
    ]);
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const projectByAsset = new Map(projects.map((project) => [project.assetId, project]));
    return this.actorEnrichment.enrich(
      jobs.map((job) => {
        const asset = assetById.get(job.assetId);
        const metadata = asset?.sourceMetadata ?? {};
        const project = projectByAsset.get(job.assetId);
        return {
          ...job,
          source: renderJobSource(job),
          asset: asset
            ? {
                id: asset.id,
                assetType: asset.assetType,
                originalFilename: asset.originalFilename,
                mimeType: asset.mimeType,
                fileSizeBytes: asset.fileSizeBytes,
                processingStatus: asset.processingStatus,
                width: readNumber(metadata.width),
                height: readNumber(metadata.height),
                durationSeconds: readNumber(metadata.durationSeconds),
              }
            : null,
          project: project ? { id: project.id, name: project.name } : null,
          outputs: variants
            .filter((variant) => variant.assetId === job.assetId)
            .map((variant) => ({
              variantCode: variant.variantCode,
              mimeType: variant.mimeType,
              width: variant.width,
              height: variant.height,
              fileSizeBytes: variant.fileSizeBytes,
              hasWatermark: variant.hasWatermark,
              renderVersion: variant.renderVersion,
            })),
        };
      }) as unknown as Array<Record<string, unknown>>,
      [{ id: 'createdBy', target: 'createdByUser' }],
    );
  }

  async retryJob(id: string, userId: string, userType?: 'ADMIN' | 'USER') {
    const job = await this.jobRepository.findOne({ where: { id } });
    if (!job) {
      throw new NotFoundException('Render job not found');
    }
    if (job.renderBatchId) {
      await this.getBatch(job.renderBatchId, userId, userType);
    } else {
      await this.assertAssetRenderAccess(job.assetId, userId, userType);
    }
    if (job.status !== 'failed') {
      throw new ConflictException('Only failed render jobs can be retried');
    }
    if (await hasNewerRenderJob(this.dataSource.manager, job)) {
      throw new ConflictException('A newer render of this file exists; retry that one instead');
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
    // Failed BullMQ jobs are kept (removeOnFail: false), so re-adding with the same id is a no-op.
    await this.mediaQueue.addProcessingJob({
      eventId: `${job.id}-retry-${uuidv7()}`,
      assetId: job.assetId,
      renderJobId: job.id,
      userId,
    });
    return this.jobRepository.findOneOrFail({ where: { id } });
  }

  /**
   * Queues every failed job of the batch again, except those whose file has a newer render
   * (the older render must not overwrite that one's previews). A cancelled batch stays
   * cancelled whatever its jobs do, and a paused one queues its failed jobs itself when resumed,
   * so neither can be retried here.
   */
  async retryFailedJobs(
    id: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{ batch: RenderBatchEntity; retriedJobs: number }> {
    await this.getBatch(id, userId, userType);
    const jobs = await this.dataSource.transaction(async (manager) => {
      // Locked so a concurrent cancel or pause cannot slip in between the check and the update.
      const batch = await manager.findOne(RenderBatchEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!batch) {
        throw new NotFoundException('Render batch not found');
      }
      if (batch.status === 'cancelled') {
        throw new ConflictException('A cancelled render batch cannot be retried');
      }
      if (batch.status === 'paused') {
        throw new ConflictException('Resume the render batch to retry its failed jobs');
      }
      const result = await manager
        .createQueryBuilder()
        .update(MediaRenderJobEntity)
        .set({
          status: 'queued',
          progressPercent: 0,
          progressMessage: 'Queued for retry',
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
        })
        .where(
          `render_batch_id = :id AND status = 'failed'
           AND NOT EXISTS (
             SELECT 1 FROM media_render_jobs newer
             WHERE newer.asset_id = media_render_jobs.asset_id
               AND newer.id <> media_render_jobs.id
               AND newer.created_at > media_render_jobs.created_at
               AND newer.status <> 'cancelled'
           )`,
          { id },
        )
        .returning(['id', 'assetId'])
        .execute();
      const rows = result.raw as Array<{ id: string; asset_id: string }>;
      if (rows.length === 0) {
        throw new ConflictException('No failed render job of this batch can be retried');
      }
      // Back to processing, so the batch counts its retried jobs as not done yet.
      await refreshRenderBatch(manager, id);
      return rows;
    });
    // After the commit, so the workers see the jobs queued when they claim them. Failed BullMQ
    // jobs are kept (removeOnFail: false), so each retry needs a new BullMQ job id.
    await Promise.all(
      jobs.map((job) =>
        this.mediaQueue.addProcessingJob({
          eventId: `${job.id}-retry-${uuidv7()}`,
          assetId: job.asset_id,
          renderJobId: job.id,
          userId,
        }),
      ),
    );
    return {
      batch: await this.getBatch(id, userId, userType),
      retriedJobs: jobs.length,
    };
  }

  async cancelBatch(
    id: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<RenderBatchEntity> {
    const batch = await this.getBatch(id, userId, userType);
    if (['completed', 'partial', 'failed', 'cancelled'].includes(batch.status)) {
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

  /**
   * Stops workers from starting more jobs of the batch; the jobs already rendering finish. The
   * queued jobs keep their place and are queued again by resumeBatch.
   */
  async pauseBatch(
    id: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<RenderBatchEntity> {
    await this.getBatch(id, userId, userType);
    await this.batchRepository.update(
      { id, status: In(['queued', 'processing']) },
      { status: 'paused' },
    );
    return this.batchRepository.findOneOrFail({ where: { id } });
  }

  /**
   * Queues a paused batch again: every job not rendered yet gets a new BullMQ job, since the
   * ones it had were skipped while the batch was paused (see MediaProcessingService).
   */
  async resumeBatch(
    id: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<RenderBatchEntity> {
    await this.getBatch(id, userId, userType);
    const maxAttempts = this.config.getOrThrow<number>('MEDIA_JOB_ATTEMPTS');
    const jobs = await this.dataSource.transaction(async (manager) => {
      const resumed = await manager.update(
        RenderBatchEntity,
        { id, status: 'paused' },
        { status: 'processing', errorMessage: null },
      );
      if (!resumed.affected) {
        return [];
      }
      // A job that failed while the batch was paused lost its BullMQ retries to the pause
      // (each one found the batch paused), so it gets them back, unless a newer render of its
      // file exists: the older render must not overwrite that one's previews.
      await manager
        .createQueryBuilder()
        .update(MediaRenderJobEntity)
        .set({
          status: 'queued',
          progressPercent: 0,
          progressMessage: 'Queued again after the batch was resumed',
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
        })
        .where(
          `render_batch_id = :id AND status = 'failed' AND attempt_count < :maxAttempts
           AND NOT EXISTS (
             SELECT 1 FROM media_render_jobs newer
             WHERE newer.asset_id = media_render_jobs.asset_id
               AND newer.id <> media_render_jobs.id
               AND newer.created_at > media_render_jobs.created_at
               AND newer.status <> 'cancelled'
           )`,
          { id, maxAttempts },
        )
        .execute();
      const queued = await manager.find(MediaRenderJobEntity, {
        select: { id: true, assetId: true },
        where: { renderBatchId: id, status: 'queued' },
        order: { createdAt: 'ASC' },
      });
      await refreshRenderBatch(manager, id);
      return queued;
    });
    // After the commit, so the workers see the batch resumed when they claim these jobs.
    await Promise.all(
      jobs.map((job) =>
        this.mediaQueue.addProcessingJob({
          eventId: `${job.id}-resume-${uuidv7()}`,
          assetId: job.assetId,
          renderJobId: job.id,
          userId,
        }),
      ),
    );
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

  /** Jobs queued outside a batch: the user must be able to edit a project holding the asset. */
  private async assertAssetRenderAccess(
    assetId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<void> {
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT project.folder_id AS "folderId"
       FROM project_media media
       INNER JOIN projects project ON project.id = media.project_id
       WHERE media.asset_id = $1`,
      [assetId],
    )) as Array<{ folderId: string }>;
    for (const row of rows) {
      if (await this.folderAccess.canAccess(row.folderId, userId, 'editor', userType)) {
        return;
      }
    }
    throw new ForbiddenException('Insufficient render job permission');
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

/** What queued a job, read from the dedupe key each producer writes. */
function renderJobSource(job: MediaRenderJobEntity): RenderJobSource {
  if (job.renderBatchId) {
    return 'batch';
  }
  if (job.dedupeKey.includes(':system:')) {
    return 'upload';
  }
  if (job.dedupeKey.includes(':import:')) {
    return 'import';
  }
  if (job.dedupeKey.includes(':retry:')) {
    return 'retry';
  }
  return 'other';
}

function readNumber(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}
