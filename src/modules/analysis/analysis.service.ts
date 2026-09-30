import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { isAdminUserType, type UserType } from '../../common/auth/user-type';
import { OutboxService } from '../../common/outbox.service';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import {
  AnalysisStatus,
  AssetAnalysisEntity,
  IN_FLIGHT_STATUSES,
} from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { MediaSegmentEntity } from '../../database/entities/media-segment.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { AnalysisEnqueueService } from './analysis-enqueue.service';

export type AnalysisSummary = {
  id: string;
  status: AnalysisStatus;
  reason: string | null;
  extractVersion: string;
  promptVersion: string;
  segmentCount: number;
  usableCount: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

export type AnalysisStatsResult = {
  counts: Record<AnalysisStatus | 'none', number>;
  segments: { total: number; usable: number };
};

export type BackfillResult = {
  matched: number;
  enqueued: number;
  skipped: number;
  dryRun: boolean;
};

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(MediaSegmentEntity)
    private readonly segmentRepo: Repository<MediaSegmentEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepo: Repository<ProjectEntity>,
    @InjectRepository(ProjectMediaEntity)
    private readonly projectMediaRepo: Repository<ProjectMediaEntity>,
    @InjectRepository(FolderClosureEntity)
    private readonly closureRepo: Repository<FolderClosureEntity>,
    @InjectRepository(AnalysisFarmJobEntity)
    private readonly farmJobRepo: Repository<AnalysisFarmJobEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly outboxService: OutboxService,
    private readonly enqueueService: AnalysisEnqueueService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  async getStats(folderIds?: string[]): Promise<AnalysisStatsResult> {
    const counts: Record<string, number> = { none: 0 };
    const statuses: AnalysisStatus[] = [
      'queued',
      'extracting',
      'extracted',
      'describing',
      'completed',
      'failed',
      'cancelled',
    ];
    for (const s of statuses) counts[s] = 0;

    let assetQuery = this.assetRepo.createQueryBuilder('asset');
    if (folderIds && folderIds.length > 0) {
      assetQuery = assetQuery
        .innerJoin(ProjectMediaEntity, 'pm', 'pm.asset_id = asset.id')
        .innerJoin(ProjectEntity, 'p', 'p.id = pm.project_id')
        .where('p.folder_id IN (:...folderIds)', { folderIds });
    }
    const assets = await assetQuery
      .select('asset.id', 'id')
      .distinct(true)
      .getRawMany<{ id: string }>();
    const assetIds = assets.map((a) => a.id);

    if (assetIds.length === 0) {
      return { counts: counts as AnalysisStatsResult['counts'], segments: { total: 0, usable: 0 } };
    }

    // Count assets by their latest analysis status
    const rows = await this.dataSource.query<{ status: string; cnt: string }[]>(
      `SELECT a.status, COUNT(*) AS cnt
       FROM asset_analyses a
       WHERE a.asset_id = ANY($1::uuid[])
         AND a.is_current = true
       GROUP BY a.status`,
      [assetIds],
    );
    let analysedCount = 0;
    for (const row of rows) {
      counts[row.status] = Number(row.cnt);
      analysedCount += Number(row.cnt);
    }
    counts['none'] = assetIds.length - analysedCount;

    // Segment counts for current segments
    const segRows = await this.dataSource.query<{ total: string; usable: string }[]>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE usable = true) AS usable
       FROM media_segments
       WHERE asset_id = ANY($1::uuid[]) AND is_current = true`,
      [assetIds],
    );
    const segRow = segRows[0] ?? { total: '0', usable: '0' };

    return {
      counts: counts as AnalysisStatsResult['counts'],
      segments: { total: Number(segRow.total), usable: Number(segRow.usable) },
    };
  }

  // ---------------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------------

  async backfill(options: {
    folderIds?: string[];
    projectIds?: string[];
    mode: 'missing' | 'outdated' | 'all';
    priority?: number;
    dryRun?: boolean;
    requestedBy?: string;
  }): Promise<BackfillResult> {
    const { folderIds, projectIds, mode, priority = 0, dryRun = false, requestedBy } = options;
    const extractVersion = this.config.get<string>('ANALYSIS_EXTRACT_VERSION') ?? 'x1';
    const promptVersion = this.config.get<string>('ANALYSIS_PROMPT_VERSION') ?? 'p1';

    // Build the list of asset ids to consider
    let assetQuery = this.assetRepo
      .createQueryBuilder('asset')
      .distinct(true)
      .select('asset.id', 'id')
      .innerJoin(ProjectMediaEntity, 'pm', 'pm.asset_id = asset.id')
      .innerJoin(ProjectEntity, 'p', 'p.id = pm.project_id');

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (projectIds && projectIds.length > 0) {
      conditions.push('p.id IN (:...projectIds)');
      params['projectIds'] = projectIds;
    }

    if (folderIds && folderIds.length > 0) {
      // Include subfolders via closure table
      const closureRows = await this.closureRepo.find({
        where: { ancestorId: In(folderIds) },
        select: { descendantId: true },
      });
      const allFolderIds = [...new Set([...folderIds, ...closureRows.map((r) => r.descendantId)])];
      conditions.push('p.folder_id IN (:...allFolderIds)');
      params['allFolderIds'] = allFolderIds;
    }

    if (conditions.length > 0) {
      assetQuery = assetQuery.where(conditions.join(' AND '), params);
    }

    const assetRows = await assetQuery.getRawMany<{ id: string }>();
    const assetIds = assetRows.map((r) => r.id);

    if (assetIds.length === 0) {
      return { matched: 0, enqueued: 0, skipped: 0, dryRun };
    }

    // Determine which assets to enqueue based on mode
    const toEnqueue: string[] = [];
    const toSkip: string[] = [];

    const currentAnalyses = await this.analysisRepo.find({
      where: { assetId: In(assetIds), isCurrent: true },
      select: { assetId: true, extractVersion: true, promptVersion: true },
    });
    const inFlight = await this.analysisRepo.find({
      where: { assetId: In(assetIds), status: In(IN_FLIGHT_STATUSES) },
      select: { assetId: true },
    });
    const inFlightSet = new Set(inFlight.map((a) => a.assetId));
    const currentMap = new Map(currentAnalyses.map((a) => [a.assetId, a]));

    for (const assetId of assetIds) {
      if (inFlightSet.has(assetId)) {
        toSkip.push(assetId);
        continue;
      }
      const current = currentMap.get(assetId);
      if (mode === 'missing' && current) {
        toSkip.push(assetId);
        continue;
      }
      if (
        mode === 'outdated' &&
        current &&
        current.extractVersion === extractVersion &&
        current.promptVersion === promptVersion
      ) {
        toSkip.push(assetId);
        continue;
      }
      toEnqueue.push(assetId);
    }

    if (dryRun) {
      return {
        matched: assetIds.length,
        enqueued: toEnqueue.length,
        skipped: toSkip.length,
        dryRun,
      };
    }

    let enqueued = 0;
    for (const assetId of toEnqueue) {
      const id = await this.dataSource.transaction(async (manager) => {
        return this.enqueueService.enqueueInsideTransaction(
          manager,
          { id: assetId },
          { requestedBy, priority, skipIfCurrent: false, skipIfInFlight: true },
        );
      });
      if (id) enqueued++;
    }

    return { matched: assetIds.length, enqueued, skipped: toSkip.length, dryRun };
  }

  // ---------------------------------------------------------------------------
  // Enqueue for a single asset
  // ---------------------------------------------------------------------------

  async enqueueForAsset(
    assetId: string,
    userId: string,
    userType: string | undefined,
    options: { priority?: number } = {},
  ): Promise<{ analysisId: string; status: AnalysisStatus }> {
    // Check access
    await this.requireAssetAccess(assetId, userId, userType);

    // Check for in-flight
    const inFlight = await this.analysisRepo.findOne({
      where: IN_FLIGHT_STATUSES.map((s) => ({ assetId, status: s })),
    });
    if (inFlight) {
      throw new ConflictException(
        `An analysis is already in flight for asset ${assetId} (${inFlight.status})`,
      );
    }

    const analysisId = await this.dataSource.transaction(async (manager) => {
      return this.enqueueService.enqueueInsideTransaction(
        manager,
        { id: assetId },
        {
          requestedBy: userId,
          priority: options.priority ?? 0,
          skipIfCurrent: false,
          skipIfInFlight: true,
        },
      );
    });

    if (!analysisId) {
      throw new ConflictException(`Could not enqueue analysis for asset ${assetId}`);
    }

    return { analysisId, status: 'queued' };
  }

  // ---------------------------------------------------------------------------
  // Get analysis for asset
  // ---------------------------------------------------------------------------

  async getAnalysisForAsset(
    assetId: string,
    userId: string,
    userType: string | undefined,
  ): Promise<{ current: AnalysisSummary | null; latest: AnalysisSummary | null }> {
    await this.requireAssetAccess(assetId, userId, userType);

    const [current, latest] = await Promise.all([
      this.analysisRepo.findOne({ where: { assetId, isCurrent: true } }),
      this.analysisRepo.findOne({
        where: { assetId },
        order: { createdAt: 'DESC' },
      }),
    ]);

    return {
      current: current ? await this.toSummary(current) : null,
      latest: latest ? await this.toSummary(latest) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Get segments for asset
  // ---------------------------------------------------------------------------

  async getSegmentsForAsset(
    assetId: string,
    userId: string,
    userType: string | undefined,
  ): Promise<{
    analysisId: string | null;
    segments: Array<{
      id: string;
      index: number;
      startMs: number;
      endMs: number;
      keyframeUrls: string[];
      captionVi: string | null;
      captionEn: string | null;
      tags: string[] | null;
      usable: boolean | null;
      usableReason: string | null;
      quality: number | null;
      shotSize: string | null;
      dead: boolean;
      deadReason: string | null;
    }>;
  }> {
    await this.requireAssetAccess(assetId, userId, userType);

    const analysis = await this.analysisRepo.findOne({ where: { assetId, isCurrent: true } });
    if (!analysis) {
      return { analysisId: null, segments: [] };
    }

    const segments = await this.segmentRepo.find({
      where: { analysisId: analysis.id, isCurrent: true },
      order: { segmentIndex: 'ASC' },
    });

    const asset = await this.assetRepo.findOne({ where: { id: assetId } });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    const analysisPrefix = `${assetVariantsPrefix(asset.originalStorageKey, assetId)}analysis/${analysis.id}/`;
    const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;

    const result = await Promise.all(
      segments.map(async (seg) => {
        const keyframes = (seg.keyframes ?? []) as Array<{ output: string }>;
        const keyframeUrls = await Promise.all(
          keyframes.map((kf) =>
            this.storage.getPresignedGetUrl(`${analysisPrefix}${kf.output}`, 'image/jpeg', ttl),
          ),
        );
        const tech = seg.technical as { dead?: boolean; dead_reason?: string } | null;
        return {
          id: seg.id,
          index: seg.segmentIndex,
          startMs: seg.startMs,
          endMs: seg.endMs,
          keyframeUrls,
          captionVi: seg.captionVi,
          captionEn: seg.captionEn,
          tags: seg.tags,
          usable: seg.usable,
          usableReason: seg.usableReason,
          quality: seg.quality,
          shotSize: seg.shotSize,
          dead: tech?.dead ?? false,
          deadReason: tech?.dead_reason ?? null,
        };
      }),
    );

    return { analysisId: analysis.id, segments: result };
  }

  // ---------------------------------------------------------------------------
  // Project analysis status
  // ---------------------------------------------------------------------------

  async getProjectAnalysisStatus(
    projectId: string,
    userId: string,
    userType: string | undefined,
  ): Promise<{
    items: Array<{
      assetId: string;
      status: string | null;
      segmentCount: number;
      usableCount: number;
    }>;
  }> {
    await this.requireProjectAccess(projectId, userId, userType);

    const mediaRows = await this.projectMediaRepo.find({
      where: { projectId },
      select: { assetId: true },
    });
    const assetIds = mediaRows.map((m) => m.assetId);

    if (assetIds.length === 0) {
      return { items: [] };
    }

    const analyses = await this.analysisRepo.find({
      where: { assetId: In(assetIds), isCurrent: true },
      select: { assetId: true, status: true, id: true },
    });
    const analysisMap = new Map(analyses.map((a) => [a.assetId, a]));

    const analysisIds = analyses.map((a) => a.id);
    let segmentCounts: Array<{ analysis_id: string; total: string; usable: string }> = [];
    if (analysisIds.length > 0) {
      segmentCounts = await this.dataSource.query(
        `SELECT analysis_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE usable = true) AS usable
         FROM media_segments
         WHERE analysis_id = ANY($1::uuid[]) AND is_current = true
         GROUP BY analysis_id`,
        [analysisIds],
      );
    }
    const segMap = new Map(segmentCounts.map((s) => [s.analysis_id, s]));

    const items = assetIds.map((assetId) => {
      const analysis = analysisMap.get(assetId);
      const seg = analysis ? segMap.get(analysis.id) : undefined;
      return {
        assetId,
        status: analysis?.status ?? null,
        segmentCount: seg ? Number(seg.total) : 0,
        usableCount: seg ? Number(seg.usable) : 0,
      };
    });

    return { items };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async toSummary(analysis: AssetAnalysisEntity): Promise<AnalysisSummary> {
    const counts = await this.dataSource.query<{ total: string; usable: string }[]>(
      `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE usable = true) AS usable
       FROM media_segments WHERE analysis_id = $1 AND is_current = true`,
      [analysis.id],
    );
    const row = counts[0] ?? { total: '0', usable: '0' };
    return {
      id: analysis.id,
      status: analysis.status,
      reason: analysis.reason,
      extractVersion: analysis.extractVersion,
      promptVersion: analysis.promptVersion,
      segmentCount: Number(row.total),
      usableCount: Number(row.usable),
      createdAt: analysis.createdAt,
      updatedAt: analysis.updatedAt,
      completedAt: analysis.completedAt,
    };
  }

  /** Requires the user can view the asset. Throws NotFoundException or ForbiddenException. */
  private async requireAssetAccess(
    assetId: string,
    userId: string,
    userType: string | undefined,
  ): Promise<AssetEntity> {
    const asset = await this.assetRepo.findOne({ where: { id: assetId } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (isAdminUserType(userType as UserType | undefined) || asset.createdBy === userId)
      return asset;

    const projects = await this.projectRepo
      .createQueryBuilder('p')
      .innerJoin(ProjectMediaEntity, 'pm', 'pm.project_id = p.id')
      .where('pm.asset_id = :assetId', { assetId })
      .getMany();

    for (const project of projects) {
      const hasFolderAccess = await this.dataSource.query<{ ok: boolean }[]>(
        `SELECT EXISTS (
          SELECT 1 FROM folder_access_grants g
          JOIN folder_closure c ON c.ancestor_id = g.folder_id
          WHERE c.descendant_id = $1
            AND g.principal_type = 'user' AND g.principal_id = $2
            AND (c.depth = 0 OR g.inherit_children = true)
         ) AS ok`,
        [project.folderId, userId],
      );
      if (hasFolderAccess[0]?.ok) return asset;
    }
    throw new ForbiddenException('Insufficient access to this asset');
  }

  /** Requires the user can access the project. */
  private async requireProjectAccess(
    projectId: string,
    userId: string,
    userType: string | undefined,
  ): Promise<ProjectEntity> {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    if (isAdminUserType(userType as UserType | undefined)) return project;

    const hasFolderAccess = await this.dataSource.query<{ ok: boolean }[]>(
      `SELECT EXISTS (
        SELECT 1 FROM folder_access_grants g
        JOIN folder_closure c ON c.ancestor_id = g.folder_id
        WHERE c.descendant_id = $1
          AND g.principal_type = 'user' AND g.principal_id = $2
          AND (c.depth = 0 OR g.inherit_children = true)
       ) AS ok`,
      [project.folderId, userId],
    );
    if (!hasFolderAccess[0]?.ok)
      throw new ForbiddenException('Insufficient access to this project');
    return project;
  }
}
