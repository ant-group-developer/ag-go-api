import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import {
  AssetAnalysisEntity,
  FINISHED_STATUSES,
} from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';
import { FarmClient } from './farm/farm-client';
import type { JobView } from './farm/protocol';
import {
  AI_MANIFEST_PATH,
  AiManifestSchema,
  EXTRACT_MANIFEST_PATH,
  ExtractManifestSchema,
  type AiManifest,
  type ExtractManifest,
} from './farm/scan';

/** How long one outbox host may hold a farm result while ingesting it. */
const PROCESSING_LOCK_SECONDS = 300;

/**
 * `<analysisId>:extract` or `<analysisId>:ai` — the correlation ids this module submits (v1 used
 * `:ai:<chunk>`; such leftovers are still recognised and ignored because their analysis is closed).
 */
const CORRELATION_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(extract|ai(?::\d+)?)$/;

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
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AnalysisFarmJobEntity)
    private readonly farmJobRepo: Repository<AnalysisFarmJobEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly farmClient: FarmClient,
    private readonly pipeline: AnalysisPipelineService,
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
    if (!loaded || FINISHED_STATUSES.includes(loaded.analysis.status)) {
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

    const { technical } = manifest;
    const frame = originalFrame(asset, manifest.media);
    const artifacts: Record<string, unknown> = {
      media: { ...manifest.media, ...frame },
      scenes: manifest.scenes.length,
    };
    // The worker read a rendered preview, not the original: keep the size it actually scanned
    if (frame.width !== manifest.media.width || frame.height !== manifest.media.height) {
      artifacts['scanned_frame'] = { width: manifest.media.width, height: manifest.media.height };
    }
    if (manifest.proxy) artifacts['proxy'] = manifest.proxy;
    if (manifest.contact_sheet) artifacts['contact_sheet'] = manifest.contact_sheet;
    // A paused analysis stays paused (resume sends the description step); otherwise it is extracted.
    await this.analysisRepo.update(analysis.id, {
      ...(analysis.status === 'paused' ? {} : { status: 'extracted' as const }),
      artifacts: artifacts as Record<string, NonNullable<unknown>>,
      technical: technical as unknown as Record<string, NonNullable<unknown>>,
      keyframes: manifest.keyframes as unknown as Record<string, NonNullable<unknown>>[],
      durationMs: manifest.media.duration_ms,
      orientation: manifest.orientation,
      hasAudio: manifest.media.has_audio,
      hasSpeech: technical.has_speech_hint,
      ...(technical.dead ? { usable: false, quality: 0 } : {}),
    });

    // The description job is submitted before the extract result counts as ingested; a failure
    // throws, the result is not acked, and the next poll submits again (the farm dedupes).
    let describing = false;
    if (!technical.dead && analysis.status !== 'paused') {
      describing = await this.pipeline.submitAi(analysis.id);
    }
    await this.markIngested(this.dataSource.manager, row, 'ingested');
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.extracted',
      message: technical.dead
        ? `Extracted ${asset.originalFilename}: technically unusable (${technical.dead_reason ?? 'dead'}), not described`
        : `Extracted ${asset.originalFilename}: ${manifest.scenes.length} scenes, ${manifest.keyframes.length} keyframes` +
          (describing ? ', sent for description' : ', description waits for the batch'),
      metadata: {
        analysisId: analysis.id,
        assetId: asset.id,
        farmJobId: row.farmJobId,
        scenes: manifest.scenes.length,
        keyframes: manifest.keyframes.length,
        dead: technical.dead,
      },
    });
    await this.pipeline.finalizeIfDone(analysis.id);
  }

  // ---------------------------------------------------------------------------
  // scan.ai completed
  // ---------------------------------------------------------------------------

  private async handleAiCompleted(row: AnalysisFarmJobEntity): Promise<void> {
    const loaded = await this.loadAnalysis(row);
    if (!loaded || FINISHED_STATUSES.includes(loaded.analysis.status)) {
      await this.markIngested(this.dataSource.manager, row, 'ingested');
      return;
    }
    const { analysis, asset, prefix } = loaded;

    let manifest: AiManifest;
    try {
      manifest = AiManifestSchema.parse(
        JSON.parse(await this.storage.getObjectText(`${prefix}${AI_MANIFEST_PATH}`)),
      );
    } catch (error) {
      await this.markAnalysisFailed(
        row,
        `Failed to read ${AI_MANIFEST_PATH}: ${errorMessage(error)}`,
      );
      return;
    }
    const description = manifest.description;
    if (!description) {
      await this.markAnalysisFailed(row, `No description: ${manifest.error ?? 'unknown error'}`);
      return;
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(AssetAnalysisEntity, analysis.id, {
        description: description as unknown as Record<string, NonNullable<unknown>>,
        describedAt: new Date(),
        usable: description.usable,
        quality: description.quality,
        models: { ai: manifest.model },
      });
      await this.markIngested(manager, row, 'ingested');
    });
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.ai_ingested',
      message: `Described ${asset.originalFilename}: ${description.title_vi}`,
      metadata: { analysisId: analysis.id, assetId: asset.id, farmJobId: row.farmJobId },
    });
    await this.pipeline.finalizeIfDone(analysis.id);
  }

  // ---------------------------------------------------------------------------
  // Failed
  // ---------------------------------------------------------------------------

  private async handleFailed(row: AnalysisFarmJobEntity, job: JobView): Promise<void> {
    const reason = job.error
      ? `Farm job ${job.status}: ${job.error.code} — ${job.error.message}`
      : `Farm job ${job.status}`;
    await this.markAnalysisFailed(row, reason);

    // The analysis cannot complete any more: stop what is still waiting at the farm.
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
      // The first failure keeps its reason; a finished analysis is never turned into a failure.
      if (analysis && !FINISHED_STATUSES.includes(analysis.status)) {
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
      message: `${await this.assetLabel(assetId)}: ${row.type} failed — ${reason}`,
      metadata: { analysisId: row.analysisId, assetId, farmJobId: row.farmJobId, type: row.type },
    });
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
    const [, analysisId, kind] = match as unknown as [string, string, string];
    if (!(await this.analysisRepo.count({ where: { id: analysisId } }))) return null;
    await this.pipeline.recordFarmJob(
      job.id,
      analysisId,
      kind === 'extract' ? 'scan.extract' : 'scan.ai',
    );
    return this.farmJobRepo.findOne({ where: { farmJobId: job.id } });
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
}

/**
 * Displayed size of the original. scan.extract may have read a clean rendered preview (same
 * aspect, smaller), so the size probed when the original was processed is used, turned to the
 * scanned orientation since that probe is taken before rotation. Without it the scanned size stays.
 */
function originalFrame(
  asset: AssetEntity,
  media: ExtractManifest['media'],
): { width: number; height: number } {
  const { width, height } = (asset.sourceMetadata ?? {}) as { width?: unknown; height?: unknown };
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { width: media.width, height: media.height };
  }
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (media.width > media.height) return { width: long, height: short };
  if (media.width < media.height) return { width: short, height: long };
  return { width, height };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
