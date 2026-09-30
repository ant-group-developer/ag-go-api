import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { OutboxService } from '../../common/outbox.service';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaSegmentEntity } from '../../database/entities/media-segment.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { AnalysisLogService } from './analysis-log.service';
import { FarmClient } from './farm/farm-client';
import type { JobView } from './farm/protocol';
import {
  AiManifestSchema,
  EXTRACT_MANIFEST_PATH,
  ExtractManifestSchema,
  SCAN_AI_MAX_CHUNK,
  ScanAiPayloadSchema,
  type AiManifest,
  type ExtractManifest,
} from './farm/scan';

/** How long one outbox host may hold a farm result while ingesting it. */
const PROCESSING_LOCK_SECONDS = 300;

/** `<analysisId>:extract` or `<analysisId>:ai:<chunk>` — the correlation ids this module submits. */
const CORRELATION_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(extract|ai:(\d+))$/;

/** Statuses after which farm results for the analysis are recorded but change nothing. */
const CLOSED_STATUSES = ['completed', 'failed', 'cancelled'];

type LoadedAnalysis = { analysis: AssetAnalysisEntity; asset: AssetEntity; prefix: string };

/**
 * Polls ag-farm for completed/failed scan jobs and ingests their results.
 * Runs only in the `outbox` worker role, and only when FARM_URL is configured. Several outbox
 * hosts may run it at once: each result is locked (`locked_until`) while one host ingests it, and
 * every step is idempotent, so a result that fails half-way is simply processed again next poll.
 */
@Injectable()
export class FarmResultPollerService implements OnModuleDestroy {
  private readonly logger = new Logger(FarmResultPollerService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;
  /**
   * The last error written to the processing log, per farm job and for the poll itself. A failing
   * result is retried every poll; only a new error text is logged, not every repeat of the same one.
   */
  private readonly loggedJobErrors = new Map<string, string>();
  private loggedPollError?: string;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(MediaSegmentEntity)
    private readonly segmentRepo: Repository<MediaSegmentEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AnalysisFarmJobEntity)
    private readonly farmJobRepo: Repository<AnalysisFarmJobEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly farmClient: FarmClient,
    private readonly outboxService: OutboxService,
    private readonly analysisLog: AnalysisLogService,
    private readonly config: ConfigService,
  ) {}

  start(): void {
    if (!this.farmClient.isConfigured) {
      this.logger.warn(
        'FARM_URL or FARM_OWNER_KEY not configured — FarmResultPollerService will not poll',
      );
      return;
    }
    if (this.timer) return;
    const interval = this.config.get<number>('FARM_POLL_INTERVAL_MS') ?? 5_000;
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
    void this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One polling pass; skipped while the previous pass is still running. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const jobs = await this.farmClient.listUnackedFinished(50);
      this.loggedPollError = undefined;
      for (const job of jobs) {
        try {
          if (await this.processJob(job)) {
            await this.farmClient.ackJob(job.id);
          }
          this.loggedJobErrors.delete(job.id);
        } catch (error) {
          // Not acked: the result shows up again next poll and is processed again.
          const message = errorMessage(error);
          this.logger.error(`Failed to process farm job ${job.id}: ${message}`);
          if (this.loggedJobErrors.get(job.id) !== message) {
            this.loggedJobErrors.set(job.id, message);
            await this.analysisLog.write({
              level: 'error',
              action: 'analysis.ingest_failed',
              message: `Could not process farm result ${job.type} (${job.correlation_id}): ${message} (retrying)`,
              metadata: { farmJobId: job.id, correlationId: job.correlation_id, type: job.type },
            });
          }
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`Farm poll failed: ${message}`);
      if (this.loggedPollError !== message) {
        this.loggedPollError = message;
        await this.analysisLog.write({
          level: 'error',
          action: 'analysis.poll_failed',
          message: `Could not read results from the farm: ${message}`,
        });
      }
    } finally {
      this.polling = false;
    }
  }

  /** Ingests one finished farm job. Returns whether it may be acked. */
  async processJob(job: JobView): Promise<boolean> {
    const row = await this.findOrAdoptFarmJob(job);
    if (!row) {
      this.logger.warn(`Unknown farm job ${job.id} (${job.correlation_id}) — acknowledging`);
      return true;
    }
    if (row.ingestedAt) return true;
    if (!(await this.lock(row.farmJobId))) {
      return false; // another outbox host is ingesting it
    }

    try {
      if (job.status === 'failed' || job.status === 'cancelled') {
        await this.handleFailed(row, job);
      } else if (job.status !== 'completed') {
        this.logger.warn(`Farm job ${job.id} has unexpected status ${job.status} — skipping`);
        return false;
      } else if (row.type === 'scan.extract') {
        await this.handleExtractCompleted(row);
      } else if (row.type === 'scan.ai') {
        await this.handleAiCompleted(row);
      } else {
        this.logger.warn(`Unknown farm job type ${row.type} for job ${job.id} — acknowledging`);
        await this.markIngested(this.dataSource.manager, row, 'ingested');
      }
      return true;
    } finally {
      await this.farmJobRepo.update(row.farmJobId, { lockedUntil: null });
    }
  }

  // ---------------------------------------------------------------------------
  // scan.extract completed
  // ---------------------------------------------------------------------------

  private async handleExtractCompleted(row: AnalysisFarmJobEntity): Promise<void> {
    const loaded = await this.loadAnalysis(row);
    if (!loaded || CLOSED_STATUSES.includes(loaded.analysis.status)) {
      await this.markIngested(this.dataSource.manager, row, 'ingested');
      return;
    }
    const { analysis, asset, prefix } = loaded;

    let manifest: ExtractManifest;
    try {
      const text = await this.storage.getObjectText(`${prefix}${EXTRACT_MANIFEST_PATH}`);
      manifest = ExtractManifestSchema.parse(JSON.parse(text));
    } catch (error) {
      await this.markAnalysisFailed(row, `Failed to read extract.json: ${errorMessage(error)}`);
      return;
    }

    // Segments are written once; a retry after a failed submission below finds them in place.
    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.count(MediaSegmentEntity, {
        where: { analysisId: analysis.id },
      });
      if (existing === 0) {
        await manager.save(
          MediaSegmentEntity,
          manifest.segments.map((segment) =>
            manager.create(MediaSegmentEntity, {
              id: uuidv7(),
              analysisId: analysis.id,
              assetId: asset.id,
              segmentIndex: segment.index,
              startMs: segment.start_ms,
              endMs: segment.end_ms,
              boundaryReason: segment.boundary_reason,
              orientation: segment.orientation,
              keyframes: segment.keyframes,
              technical: segment.technical,
              usable: segment.technical.dead ? false : null,
              usableReason: segment.technical.dead
                ? (segment.technical.dead_reason ?? 'technical')
                : null,
              isCurrent: false,
            }),
          ),
        );
      }
      const artifacts: Record<string, unknown> = { media: manifest.media };
      if (manifest.proxy) artifacts['proxy'] = manifest.proxy;
      if (manifest.contact_sheet) artifacts['contact_sheet'] = manifest.contact_sheet;
      await manager.update(AssetAnalysisEntity, analysis.id, {
        status: 'extracted',
        artifacts: artifacts as Record<string, NonNullable<unknown>>,
      });
    });

    const stored = await this.segmentRepo.find({
      where: { analysisId: analysis.id },
      order: { segmentIndex: 'ASC' },
    });
    const live = stored.filter((segment) => segment.usable !== false);
    const chunks: MediaSegmentEntity[][] = [];
    for (let i = 0; i < live.length; i += SCAN_AI_MAX_CHUNK) {
      chunks.push(live.slice(i, i + SCAN_AI_MAX_CHUNK));
    }

    // Every chunk is submitted before the extract result counts as ingested; a failure throws,
    // the result is not acked, and the next poll submits again (the farm dedupes by correlation id).
    if (chunks.length > 0) {
      const context = await this.getAssetContext(asset.id);
      const model = this.config.get<string>('ANALYSIS_MODEL') ?? 'qwen2.5vl:7b';
      const promptVersion = this.config.get<string>('ANALYSIS_PROMPT_VERSION') ?? 'p1';
      for (const [chunkIndex, segments] of chunks.entries()) {
        const payload = ScanAiPayloadSchema.parse({
          asset_id: asset.id,
          chunk: chunkIndex,
          model,
          prompt_version: promptVersion,
          context,
          segments: segments.map((segment) => ({
            segment_id: segment.id,
            index: segment.segmentIndex,
            start_ms: segment.startMs,
            end_ms: segment.endMs,
            keyframes: (segment.keyframes as { output: string }[]).map(
              (keyframe) => `artifact:${keyframe.output}`,
            ),
          })),
        });
        const response = await this.farmClient.submitJob({
          type: 'scan.ai',
          lane: 'batch',
          priority: analysis.priority,
          affinity_key: analysis.id,
          payload,
          max_attempts: 3,
          correlation_id: `${analysis.id}:ai:${chunkIndex}`,
        });
        await this.insertFarmJob(response.job.id, analysis.id, 'scan.ai', chunkIndex);
      }
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(AssetAnalysisEntity, analysis.id, {
        status: chunks.length > 0 ? 'describing' : 'extracted',
        summary: { aiChunks: chunks.length },
      });
      await this.markIngested(manager, row, 'ingested');
    });
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.extracted',
      message:
        `Extracted ${asset.originalFilename}: ${stored.length} segments (${stored.length - live.length} unusable), ` +
        `${chunks.length} AI chunk(s) sent for description`,
      metadata: {
        analysisId: analysis.id,
        assetId: asset.id,
        farmJobId: row.farmJobId,
        segmentCount: stored.length,
        aiChunks: chunks.length,
      },
    });
    await this.finalizeIfDone(analysis.id);
  }

  // ---------------------------------------------------------------------------
  // scan.ai completed
  // ---------------------------------------------------------------------------

  private async handleAiCompleted(row: AnalysisFarmJobEntity): Promise<void> {
    const loaded = await this.loadAnalysis(row);
    if (!loaded || CLOSED_STATUSES.includes(loaded.analysis.status)) {
      await this.markIngested(this.dataSource.manager, row, 'ingested');
      return;
    }
    const { analysis, asset, prefix } = loaded;
    const aiPath = `ai-${String(row.chunk ?? 0).padStart(4, '0')}.json`;

    let manifest: AiManifest;
    try {
      manifest = AiManifestSchema.parse(
        JSON.parse(await this.storage.getObjectText(`${prefix}${aiPath}`)),
      );
    } catch (error) {
      await this.markAnalysisFailed(row, `Failed to read ${aiPath}: ${errorMessage(error)}`);
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      for (const item of manifest.items) {
        const description = item.description;
        if (!description) continue;
        // Scoped to this analysis: a manifest cannot touch another analysis' segments.
        await manager.update(
          MediaSegmentEntity,
          { id: item.segment_id, analysisId: analysis.id },
          {
            captionVi: description.caption_vi,
            captionEn: description.caption_en,
            tags: description.tags,
            keywordsVi: description.keywords_vi,
            subjects: description.subjects,
            actions: description.actions,
            shotSize: description.shot_size,
            cameraMotion: description.camera_motion,
            timeOfDay: description.time_of_day,
            setting: description.setting,
            peopleCount: description.people_count,
            visibleText: description.visible_text,
            hasWatermark: description.has_watermark,
            usable: description.usable,
            usableReason: description.usable_reason,
            quality: description.quality,
            description: description as unknown as Record<string, NonNullable<unknown>>,
            describedAt: new Date(),
          },
        );
      }
      await this.markIngested(manager, row, 'ingested');
    });
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.ai_ingested',
      message: `Described ${manifest.items.filter((item) => item.description).length}/${manifest.items.length} segments of ${asset.originalFilename} (chunk ${row.chunk ?? 0})`,
      metadata: {
        analysisId: analysis.id,
        assetId: asset.id,
        farmJobId: row.farmJobId,
        chunk: row.chunk ?? 0,
      },
    });
    await this.finalizeIfDone(analysis.id);
  }

  // ---------------------------------------------------------------------------
  // Failed
  // ---------------------------------------------------------------------------

  private async handleFailed(row: AnalysisFarmJobEntity, job: JobView): Promise<void> {
    const reason = job.error
      ? `Farm job ${job.status}: ${job.error.code} — ${job.error.message}`
      : `Farm job ${job.status}`;
    await this.markAnalysisFailed(row, reason);

    // The analysis cannot complete any more: stop the chunks still waiting at the farm.
    const pending = await this.farmJobRepo.find({
      where: { analysisId: row.analysisId, ingestedAt: IsNull() },
    });
    for (const sibling of pending) {
      await this.farmClient.cancelJob(sibling.farmJobId).catch((error: unknown) => {
        this.logger.warn(`Could not cancel farm job ${sibling.farmJobId}: ${errorMessage(error)}`);
      });
    }
  }

  private async markAnalysisFailed(row: AnalysisFarmJobEntity, reason: string): Promise<void> {
    const assetId = await this.dataSource.transaction(async (manager) => {
      const analysis = await manager.findOne(AssetAnalysisEntity, {
        where: { id: row.analysisId },
        lock: { mode: 'pessimistic_write' },
      });
      // The first failure keeps its reason; a completed analysis is never turned into a failure.
      if (analysis && !CLOSED_STATUSES.includes(analysis.status)) {
        await manager.update(AssetAnalysisEntity, analysis.id, { status: 'failed', reason });
      }
      await manager.update(AnalysisFarmJobEntity, row.farmJobId, { error: { reason } });
      await this.markIngested(manager, row, 'failed');
      return analysis?.assetId ?? null;
    });
    this.logger.warn(`Analysis ${row.analysisId} failed: ${reason}`);
    await this.analysisLog.write({
      level: 'error',
      action: 'analysis.failed',
      message: `${await this.assetLabel(assetId)}: ${row.type}${row.chunk === null ? '' : ` chunk ${row.chunk}`} failed — ${reason}`,
      metadata: { analysisId: row.analysisId, assetId, farmJobId: row.farmJobId, type: row.type },
    });
  }

  // ---------------------------------------------------------------------------
  // Finalize (flip is_current)
  // ---------------------------------------------------------------------------

  /**
   * Completes the analysis once the extract result and every submitted AI chunk are ingested.
   * Safe to call from any step and from several hosts: the analysis row is locked and its status
   * re-checked inside the transaction, so it completes exactly once.
   */
  async finalizeIfDone(analysisId: string): Promise<void> {
    const completed = await this.dataSource.transaction(async (manager) => {
      const analysis = await manager.findOne(AssetAnalysisEntity, {
        where: { id: analysisId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!analysis || !['extracted', 'describing'].includes(analysis.status)) return null;

      const jobs = await manager.find(AnalysisFarmJobEntity, { where: { analysisId } });
      const extract = jobs.find((job) => job.type === 'scan.extract');
      if (extract?.status !== 'ingested') return null;
      const aiJobs = jobs.filter((job) => job.type === 'scan.ai');
      const expectedChunks = Number(
        (analysis.summary as { aiChunks?: unknown } | null)?.aiChunks ?? aiJobs.length,
      );
      if (aiJobs.length < expectedChunks || aiJobs.some((job) => job.status !== 'ingested')) {
        return null;
      }

      const segmentCount = await manager.count(MediaSegmentEntity, { where: { analysisId } });
      const usableCount = await manager.count(MediaSegmentEntity, {
        where: { analysisId, usable: true },
      });
      // Previous current rows off first: asset_analyses has a partial unique index on is_current.
      await manager.update(
        AssetAnalysisEntity,
        { assetId: analysis.assetId, isCurrent: true },
        { isCurrent: false },
      );
      await manager.update(
        MediaSegmentEntity,
        { assetId: analysis.assetId, isCurrent: true },
        { isCurrent: false },
      );
      await manager.update(AssetAnalysisEntity, analysisId, {
        status: 'completed',
        isCurrent: true,
        completedAt: new Date(),
        summary: { segmentCount, usableCount },
      });
      await manager.update(MediaSegmentEntity, { analysisId }, { isCurrent: true });
      await manager.save(
        this.outboxService.create(manager, {
          eventType: 'asset.analysis.completed',
          aggregateType: 'asset_analysis',
          aggregateId: analysisId,
          payload: { analysisId, assetId: analysis.assetId, segmentCount, usableCount },
        }),
      );
      return { assetId: analysis.assetId, segmentCount, usableCount };
    });
    if (completed) {
      this.logger.log(
        `Analysis ${analysisId} completed: ${completed.segmentCount} segments, ${completed.usableCount} usable`,
      );
      await this.analysisLog.write({
        level: 'info',
        action: 'analysis.completed',
        message: `Completed ${await this.assetLabel(completed.assetId)}: ${completed.segmentCount} segments, ${completed.usableCount} usable`,
        metadata: { analysisId, ...completed },
      });
    }
  }

  /** The asset's file name for a log message, or its id when it cannot be read. */
  private async assetLabel(assetId: string | null): Promise<string> {
    if (!assetId) return 'Unknown asset';
    const asset = await this.assetRepo.findOne({ where: { id: assetId } }).catch(() => null);
    return asset?.originalFilename ?? assetId;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * The local row of a farm job, recreated from its correlation id when it is missing (the process
   * stopped between submitting a job and saving its row, or another host is still saving it).
   */
  private async findOrAdoptFarmJob(job: JobView): Promise<AnalysisFarmJobEntity | null> {
    const row = await this.farmJobRepo.findOne({ where: { farmJobId: job.id } });
    if (row) return row;
    const match = CORRELATION_PATTERN.exec(job.correlation_id);
    if (!match) return null;
    const [, analysisId, kind, chunk] = match as unknown as [string, string, string, string?];
    if (!(await this.analysisRepo.count({ where: { id: analysisId } }))) return null;
    await this.insertFarmJob(
      job.id,
      analysisId,
      kind === 'extract' ? 'scan.extract' : 'scan.ai',
      chunk === undefined ? null : Number(chunk),
    );
    return this.farmJobRepo.findOne({ where: { farmJobId: job.id } });
  }

  private async insertFarmJob(
    farmJobId: string,
    analysisId: string,
    type: string,
    chunk: number | null,
  ): Promise<void> {
    await this.farmJobRepo
      .createQueryBuilder()
      .insert()
      .into(AnalysisFarmJobEntity)
      .values({ farmJobId, analysisId, type, chunk, status: 'submitted' })
      .orIgnore()
      .execute();
  }

  /** Takes the processing lock; false when another host holds it or the result is ingested. */
  private async lock(farmJobId: string): Promise<boolean> {
    const result = await this.farmJobRepo
      .createQueryBuilder()
      .update(AnalysisFarmJobEntity)
      .set({ lockedUntil: () => `now() + interval '${PROCESSING_LOCK_SECONDS} seconds'` })
      .where('farm_job_id = :farmJobId', { farmJobId })
      .andWhere('ingested_at IS NULL')
      .andWhere('(locked_until IS NULL OR locked_until < now())')
      .execute();
    return Boolean(result.affected);
  }

  private async markIngested(
    manager: EntityManager,
    row: AnalysisFarmJobEntity,
    status: 'ingested' | 'failed',
  ): Promise<void> {
    await manager.update(AnalysisFarmJobEntity, row.farmJobId, { status, ingestedAt: new Date() });
  }

  private async loadAnalysis(row: AnalysisFarmJobEntity): Promise<LoadedAnalysis | null> {
    const analysis = await this.analysisRepo.findOne({ where: { id: row.analysisId } });
    if (!analysis) return null;
    const asset = await this.assetRepo.findOne({ where: { id: analysis.assetId } });
    if (!asset) return null;
    const prefix = `${assetVariantsPrefix(asset.originalStorageKey, asset.id)}analysis/${analysis.id}/`;
    return { analysis, asset, prefix };
  }

  /** Hints for the vision model: the names of the asset's projects, categories and provinces. */
  private async getAssetContext(assetId: string): Promise<{
    project_names: string[];
    category_names: string[];
    province_names: string[];
  }> {
    const rows = await this.dataSource.query<
      { project_name: string | null; category_name: string | null; province_name: string | null }[]
    >(
      `SELECT p.name AS project_name, c.name AS category_name, pr.name AS province_name
         FROM project_media pm
         JOIN projects p ON p.id = pm.project_id
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN provinces pr ON pr.id = p.province_id
        WHERE pm.asset_id = $1
        LIMIT 20`,
      [assetId],
    );
    const unique = (values: (string | null)[]) =>
      [...new Set(values.filter((value): value is string => Boolean(value)))].slice(0, 10);
    return {
      project_names: unique(rows.map((row) => row.project_name)),
      category_names: unique(rows.map((row) => row.category_name)),
      province_names: unique(rows.map((row) => row.province_name)),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
