import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { isAdminUserType, type UserType } from '../../common/auth/user-type';
import {
  AnalysisStatus,
  AssetAnalysisEntity,
  IN_FLIGHT_STATUSES,
} from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { AnalysisBatchService } from './analysis-batch.service';
import { AnalysisEnqueueService } from './analysis-enqueue.service';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';
import { descriptionView, type DescriptionView } from './description-view';

/**
 * Asset processing statuses whose original object is fully stored. `uploading`, `importing`
 * and `cancelled` assets may have no original (or a partial one) and cannot be analysed.
 */
const ORIGINAL_STORED_STATUSES = ['uploaded', 'processing', 'ready', 'failed'];

export type AnalysisStatsResult = {
  counts: Record<AnalysisStatus | 'none', number>;
  videos: { analyzed: number; usable: number };
};

export type BackfillResult = {
  batchId: string | null;
  matched: number;
  enqueued: number;
  skipped: number;
  dryRun: boolean;
};

export type AssetAnalysisView = {
  id: string;
  assetId: string;
  status: AnalysisStatus;
  reason: string | null;
  isCurrent: boolean;
  batchId: string | null;
  extractVersion: string;
  promptVersion: string;
  createdAt: Date;
  completedAt: Date | null;
  /** From the current (last completed) analysis; the latest run may still be in flight. */
  description: DescriptionView | null;
  technical: {
    blackRatio: number | null;
    frozenRatio: number | null;
    blur: number | null;
    silenceRatio: number | null;
    hasSpeechHint: boolean | null;
    dead: boolean;
    deadReason: string | null;
  } | null;
  media: {
    durationMs: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    hasAudio: boolean | null;
    orientation: string | null;
  } | null;
  keyframes: { url: string; tMs: number }[];
  contactSheetUrl: string | null;
  error: string | null;
};

type StoredKeyframe = { output: string; t_ms: number };

@Injectable()
export class AnalysisService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepo: Repository<ProjectEntity>,
    @InjectRepository(ProjectMediaEntity)
    private readonly projectMediaRepo: Repository<ProjectMediaEntity>,
    @InjectRepository(FolderClosureEntity)
    private readonly closureRepo: Repository<FolderClosureEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly enqueueService: AnalysisEnqueueService,
    private readonly batchService: AnalysisBatchService,
    private readonly pipeline: AnalysisPipelineService,
    private readonly analysisLog: AnalysisLogService,
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
      'paused',
      'completed',
      'failed',
      'cancelled',
    ];
    for (const s of statuses) counts[s] = 0;

    const assetIds = await this.findScopedAssetIds({ folderIds });
    if (assetIds.length === 0) {
      return {
        counts: counts as AnalysisStatsResult['counts'],
        videos: { analyzed: 0, usable: 0 },
      };
    }

    // Count assets by the status of their latest run. Only completed runs ever become
    // is_current, so filtering on it would hide queued/in-flight/failed runs as "none".
    const rows = await this.dataSource.query<{ status: string; cnt: string }[]>(
      `SELECT latest.status, COUNT(*) AS cnt
       FROM (
         SELECT DISTINCT ON (a.asset_id) a.status
         FROM asset_analyses a
         WHERE a.asset_id = ANY($1::uuid[])
         ORDER BY a.asset_id, a.created_at DESC, a.id DESC
       ) latest
       GROUP BY latest.status`,
      [assetIds],
    );
    let analysedCount = 0;
    for (const row of rows) {
      counts[row.status] = Number(row.cnt);
      analysedCount += Number(row.cnt);
    }
    counts['none'] = assetIds.length - analysedCount;

    const videoRows = await this.dataSource.query<{ analyzed: string; usable: string }[]>(
      `SELECT COUNT(*) AS analyzed, COUNT(*) FILTER (WHERE usable = true) AS usable
       FROM asset_analyses
       WHERE asset_id = ANY($1::uuid[]) AND is_current = true`,
      [assetIds],
    );
    const videoRow = videoRows[0] ?? { analyzed: '0', usable: '0' };
    return {
      counts: counts as AnalysisStatsResult['counts'],
      videos: { analyzed: Number(videoRow.analyzed), usable: Number(videoRow.usable) },
    };
  }

  // ---------------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------------

  async backfill(options: {
    name?: string;
    folderIds?: string[];
    projectIds?: string[];
    mode: 'missing' | 'outdated' | 'all';
    priority?: number;
    dryRun?: boolean;
    requestedBy?: string;
  }): Promise<BackfillResult> {
    const { folderIds, projectIds, mode, priority = 0, dryRun = false, requestedBy } = options;
    const extractVersion = this.config.get<string>('ANALYSIS_EXTRACT_VERSION') ?? 'x2';
    const promptVersion = this.config.get<string>('ANALYSIS_PROMPT_VERSION') ?? 'p2';

    const assetIds = await this.findScopedAssetIds({ folderIds, projectIds });
    const toEnqueue: string[] = [];
    let skipped = 0;
    if (assetIds.length > 0) {
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
        const current = currentMap.get(assetId);
        const skip =
          inFlightSet.has(assetId) ||
          (mode === 'missing' && current) ||
          (mode === 'outdated' &&
            current &&
            current.extractVersion === extractVersion &&
            current.promptVersion === promptVersion);
        if (skip) skipped++;
        else toEnqueue.push(assetId);
      }
    }

    if (dryRun || toEnqueue.length === 0) {
      const result = { batchId: null, matched: assetIds.length, enqueued: 0, skipped, dryRun };
      if (dryRun) result.enqueued = toEnqueue.length;
      else await this.logBackfill(options, result);
      return result;
    }

    // The batch and all its analyses are created together: a batch is never left half-filled.
    const { batchId, enqueued } = await this.dataSource.transaction(async (manager) => {
      const batch = await this.batchService.createBackfillBatch(manager, {
        name: options.name?.trim() || defaultBatchName(mode),
        mode,
        folderIds,
        projectIds,
        priority,
        createdBy: requestedBy ?? null,
      });
      let count = 0;
      for (const assetId of toEnqueue) {
        const id = await this.enqueueService.enqueueInsideTransaction(
          manager,
          { id: assetId },
          { requestedBy, priority, skipIfCurrent: false, skipIfInFlight: true, batchId: batch.id },
        );
        if (id) count++;
      }
      return { batchId: batch.id, enqueued: count };
    });

    const result = { batchId, matched: assetIds.length, enqueued, skipped, dryRun };
    await this.logBackfill(options, result);
    return result;
  }

  private async logBackfill(
    options: {
      folderIds?: string[];
      projectIds?: string[];
      mode: string;
      priority?: number;
      requestedBy?: string;
    },
    result: BackfillResult,
  ): Promise<void> {
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.backfill',
      message: `Backfill (${options.mode}): ${result.matched} matched, ${result.enqueued} queued, ${result.skipped} skipped`,
      userId: options.requestedBy ?? null,
      metadata: {
        batchId: result.batchId,
        mode: options.mode,
        folderIds: options.folderIds ?? [],
        projectIds: options.projectIds ?? [],
        priority: options.priority ?? 0,
        matched: result.matched,
        enqueued: result.enqueued,
        skipped: result.skipped,
      },
    });
  }

  /**
   * Assets that stats and backfill operate on: assets whose original is fully stored, linked
   * to at least one project, optionally narrowed to projects and/or folders (subfolders
   * included). Analysis reads the original, not the rendered variants, so an asset not yet
   * rendered, re-rendering or with a failed render is included. Orphans, incomplete/cancelled
   * uploads and imports, and watermark logos are left out.
   */
  private async findScopedAssetIds(scope: {
    folderIds?: string[];
    projectIds?: string[];
  }): Promise<string[]> {
    const { folderIds, projectIds } = scope;
    const assetQuery = this.assetRepo
      .createQueryBuilder('asset')
      .distinct(true)
      .select('asset.id', 'id')
      .innerJoin(ProjectMediaEntity, 'pm', 'pm.asset_id = asset.id')
      .innerJoin(ProjectEntity, 'p', 'p.id = pm.project_id')
      .where('asset.processing_status IN (:...stored)', { stored: ORIGINAL_STORED_STATUSES });

    if (projectIds && projectIds.length > 0) {
      assetQuery.andWhere('p.id IN (:...projectIds)', { projectIds });
    }
    if (folderIds && folderIds.length > 0) {
      // Include subfolders via closure table
      const closureRows = await this.closureRepo.find({
        where: { ancestorId: In(folderIds) },
        select: { descendantId: true },
      });
      const allFolderIds = [...new Set([...folderIds, ...closureRows.map((r) => r.descendantId)])];
      assetQuery.andWhere('p.folder_id IN (:...allFolderIds)', { allFolderIds });
    }
    const rows = await assetQuery.getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  // ---------------------------------------------------------------------------
  // One asset
  // ---------------------------------------------------------------------------

  async enqueueForAsset(
    assetId: string,
    userId: string,
    userType: string | undefined,
    options: { priority?: number } = {},
  ): Promise<{ analysisId: string; status: AnalysisStatus }> {
    const asset = await this.requireAssetAccess(assetId, userId, userType);
    const inFlight = await this.analysisRepo.findOne({
      where: IN_FLIGHT_STATUSES.map((s) => ({ assetId, status: s })),
    });
    if (inFlight) {
      throw new ConflictException(
        `An analysis is already in flight for asset ${assetId} (${inFlight.status})`,
      );
    }
    const analysisId = await this.dataSource.transaction((manager) =>
      this.enqueueService.enqueueInsideTransaction(
        manager,
        { id: assetId },
        {
          requestedBy: userId,
          priority: options.priority ?? 0,
          skipIfCurrent: false,
          skipIfInFlight: true,
        },
      ),
    );
    if (!analysisId) throw new ConflictException(`Could not enqueue analysis for asset ${assetId}`);
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.enqueue',
      message: `Queued analysis for ${asset.originalFilename}`,
      userId,
      metadata: { analysisId, assetId, priority: options.priority ?? 0 },
    });
    return { analysisId, status: 'queued' };
  }

  /** Pause / resume / cancel the in-flight analysis of an asset. */
  async controlAssetAnalysis(
    assetId: string,
    action: 'pause' | 'resume' | 'cancel',
    userId: string,
    userType: string | undefined,
  ): Promise<{ affected: number }> {
    const asset = await this.requireAssetAccess(assetId, userId, userType);
    const analysis = await this.analysisRepo.findOne({
      where: IN_FLIGHT_STATUSES.map((s) => ({ assetId, status: s })),
      order: { createdAt: 'DESC' },
    });
    if (!analysis) return { affected: 0 };
    const changed =
      action === 'pause'
        ? await this.pipeline.pause(analysis.id)
        : action === 'resume'
          ? await this.pipeline.resume(analysis.id)
          : await this.pipeline.cancel(analysis.id, 'Cancelled by user');
    if (changed) {
      await this.analysisLog.write({
        level: 'info',
        action: `analysis.${action}`,
        message: `${action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Cancelled'} analysis of ${asset.originalFilename}`,
        userId,
        metadata: { analysisId: analysis.id, assetId },
      });
    }
    return { affected: changed ? 1 : 0 };
  }

  /** The latest run of an asset's analysis, with the description of its current (completed) run. */
  async getAnalysisForAsset(
    assetId: string,
    userId: string,
    userType: string | undefined,
  ): Promise<AssetAnalysisView | null> {
    const asset = await this.requireAssetAccess(assetId, userId, userType);
    const [current, latest] = await Promise.all([
      this.analysisRepo.findOne({ where: { assetId, isCurrent: true } }),
      this.analysisRepo.findOne({ where: { assetId }, order: { createdAt: 'DESC' } }),
    ]);
    if (!latest) return null;
    const source = current ?? latest;
    const prefix = `${assetVariantsPrefix(asset.originalStorageKey, assetId)}analysis/${source.id}/`;
    const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;
    const keyframes = await Promise.all(
      ((source.keyframes ?? []) as unknown as StoredKeyframe[]).map(async (keyframe) => ({
        url: await this.storage.getPresignedGetUrl(
          `${prefix}${keyframe.output}`,
          'image/jpeg',
          ttl,
        ),
        tMs: keyframe.t_ms,
      })),
    );
    const sheet = (source.artifacts as { contact_sheet?: { output: string } } | null)
      ?.contact_sheet;
    const media = (source.artifacts as { media?: Record<string, unknown> } | null)?.media;
    const technical = source.technical as Record<string, unknown> | null;
    return {
      id: latest.id,
      assetId,
      status: latest.status,
      reason: latest.reason,
      isCurrent: latest.isCurrent,
      batchId: latest.batchId,
      extractVersion: latest.extractVersion,
      promptVersion: latest.promptVersion,
      createdAt: latest.createdAt,
      completedAt: latest.completedAt,
      description: current?.description ? descriptionView(current.description) : null,
      technical: technical
        ? {
            blackRatio: (technical['black_ratio'] as number | undefined) ?? null,
            frozenRatio: (technical['frozen_ratio'] as number | undefined) ?? null,
            blur: (technical['blur'] as number | null | undefined) ?? null,
            silenceRatio: (technical['silence_ratio'] as number | null | undefined) ?? null,
            hasSpeechHint: (technical['has_speech_hint'] as boolean | null | undefined) ?? null,
            dead: technical['dead'] === true,
            deadReason: (technical['dead_reason'] as string | null | undefined) ?? null,
          }
        : null,
      media: media
        ? {
            durationMs: (media['duration_ms'] as number | undefined) ?? source.durationMs,
            width: (media['width'] as number | undefined) ?? null,
            height: (media['height'] as number | undefined) ?? null,
            fps: (media['fps'] as number | null | undefined) ?? null,
            hasAudio: (media['has_audio'] as boolean | undefined) ?? source.hasAudio,
            orientation: source.orientation,
          }
        : null,
      keyframes,
      contactSheetUrl: sheet
        ? await this.storage.getPresignedGetUrl(`${prefix}${sheet.output}`, 'image/jpeg', ttl)
        : null,
      error: latest.status === 'failed' ? latest.reason : null,
    };
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
      usable: boolean | null;
      quality: number | null;
      titleVi: string | null;
      completedAt: Date | null;
    }>;
  }> {
    await this.requireProjectAccess(projectId, userId, userType);
    const mediaRows = await this.projectMediaRepo.find({
      where: { projectId },
      select: { assetId: true },
    });
    const assetIds = mediaRows.map((m) => m.assetId);
    if (assetIds.length === 0) return { items: [] };

    // Latest run per asset for the status; the current run for the description
    const latestRows = await this.dataSource.query<{ asset_id: string; status: string }[]>(
      `SELECT DISTINCT ON (asset_id) asset_id, status FROM asset_analyses
        WHERE asset_id = ANY($1::uuid[]) ORDER BY asset_id, created_at DESC, id DESC`,
      [assetIds],
    );
    const latestMap = new Map(latestRows.map((r) => [r.asset_id, r.status]));
    const current = await this.analysisRepo.find({
      where: { assetId: In(assetIds), isCurrent: true },
      select: { assetId: true, usable: true, quality: true, description: true, completedAt: true },
    });
    const currentMap = new Map(current.map((a) => [a.assetId, a]));
    return {
      items: assetIds.map((assetId) => {
        const done = currentMap.get(assetId);
        return {
          assetId,
          status: latestMap.get(assetId) ?? null,
          usable: done?.usable ?? null,
          quality: done?.quality ?? null,
          titleVi: (done?.description?.['title_vi'] as string | undefined) ?? null,
          completedAt: done?.completedAt ?? null,
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------

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
      if (await this.hasFolderAccess(project.folderId, userId)) return asset;
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
    if (!(await this.hasFolderAccess(project.folderId, userId))) {
      throw new ForbiddenException('Insufficient access to this project');
    }
    return project;
  }

  private async hasFolderAccess(folderId: string, userId: string): Promise<boolean> {
    const rows = await this.dataSource.query<{ ok: boolean }[]>(
      `SELECT EXISTS (
        SELECT 1 FROM folder_access_grants g
        JOIN folder_closure c ON c.ancestor_id = g.folder_id
        WHERE c.descendant_id = $1
          AND g.principal_type = 'user' AND g.principal_id = $2
          AND (c.depth = 0 OR g.inherit_children = true)
       ) AS ok`,
      [folderId, userId],
    );
    return Boolean(rows[0]?.ok);
  }
}

function defaultBatchName(mode: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `Quét ${mode === 'missing' ? 'video chưa quét' : mode === 'outdated' ? 'lại bản cũ' : 'lại tất cả'} ${stamp}`;
}
