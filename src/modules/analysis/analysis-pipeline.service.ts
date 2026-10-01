import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { OutboxService } from '../../common/outbox.service';
import { AnalysisBatchEntity } from '../../database/entities/analysis-batch.entity';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import {
  AssetAnalysisEntity,
  FINISHED_STATUSES,
} from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { batchGroupKey } from './analysis-batches';
import { AnalysisLogService } from './analysis-log.service';
import { FarmClient } from './farm/farm-client';
import { ScanAiPayloadSchema, ScanExtractPayloadSchema } from './farm/scan';

type StoredKeyframe = { output: string; t_ms: number };

/**
 * The analysis pipeline shared by the outbox (first submission), the result poller (next steps)
 * and the batch controls: submit scan.extract / scan.ai, finish an analysis once its results are in,
 * and pause / resume / cancel one analysis.
 *
 * Every farm job carries its batch's group key (`batch:<id>`), so a whole batch is paused or
 * cancelled at the farm in one call. A paused or cancelled batch holds new submissions here:
 * the analysis is parked as `paused` (or `cancelled`) instead of being sent.
 */
@Injectable()
export class AnalysisPipelineService {
  private readonly logger = new Logger(AnalysisPipelineService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(AnalysisBatchEntity)
    private readonly batchRepo: Repository<AnalysisBatchEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AnalysisFarmJobEntity)
    private readonly farmJobRepo: Repository<AnalysisFarmJobEntity>,
    private readonly farmClient: FarmClient,
    private readonly outboxService: OutboxService,
    private readonly analysisLog: AnalysisLogService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /**
   * Sends a queued analysis to the farm (scan.extract). Idempotent: an analysis that is no longer
   * `queued` is left alone, and the farm dedupes by correlation id. Throws on farm errors so the
   * outbox retries.
   */
  async submitExtract(analysisId: string): Promise<void> {
    if (!this.farmClient.isConfigured) {
      throw new Error('FARM_URL is not configured — cannot submit scan.extract job');
    }
    const analysis = await this.analysisRepo.findOne({ where: { id: analysisId } });
    if (!analysis) throw new Error(`Analysis ${analysisId} not found`);
    if (analysis.status !== 'queued') return;
    if (await this.holdForBatch(analysis)) return;

    const asset = await this.assetRepo.findOne({ where: { id: analysis.assetId } });
    if (!asset) throw new Error(`Asset ${analysis.assetId} not found`);

    const sourceMetadata = (asset.sourceMetadata ?? {}) as Record<string, unknown>;
    const durationSeconds = sourceMetadata['durationSeconds'];
    const payload = ScanExtractPayloadSchema.parse({
      asset: {
        id: asset.id,
        kind: asset.assetType === 'video' ? 'video' : 'image',
        mime_type: asset.mimeType,
        size_bytes: Number(asset.fileSizeBytes) || null,
        checksum_sha256: asset.checksumSha256 ?? null,
        duration_ms:
          typeof durationSeconds === 'number' ? Math.round(durationSeconds * 1000) : null,
        width: typeof sourceMetadata['width'] === 'number' ? sourceMetadata['width'] : null,
        height: typeof sourceMetadata['height'] === 'number' ? sourceMetadata['height'] : null,
      },
      extract_version: analysis.extractVersion,
    });

    const response = await this.farmClient.submitJob({
      type: 'scan.extract',
      lane: 'batch',
      priority: analysis.priority,
      affinity_key: analysis.id,
      payload,
      max_attempts: 3,
      correlation_id: `${analysis.id}:extract`,
      group_key: analysis.batchId ? batchGroupKey(analysis.batchId) : null,
    });
    await this.recordFarmJob(response.job.id, analysis.id, 'scan.extract');
    // A submit error kept by an earlier attempt is over
    await this.analysisRepo.update(
      { id: analysis.id, status: 'queued' },
      { status: 'extracting', reason: null },
    );
    this.logger.log(`Submitted scan.extract ${response.job.id} for analysis ${analysis.id}`);
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.extract.submitted',
      message: `Sent ${asset.originalFilename} to the farm for extraction`,
      metadata: { analysisId: analysis.id, assetId: asset.id, farmJobId: response.job.id },
    });
  }

  /**
   * Sends the whole-video description job (scan.ai) for an extracted analysis, built from the
   * keyframes and media info stored when the extract result was ingested. Returns false when the
   * batch held it back (the analysis is then `paused` or `cancelled`).
   */
  async submitAi(analysisId: string): Promise<boolean> {
    const analysis = await this.analysisRepo.findOne({ where: { id: analysisId } });
    if (!analysis) throw new Error(`Analysis ${analysisId} not found`);
    if (!['extracted', 'paused'].includes(analysis.status)) return false;
    if (await this.holdForBatch(analysis)) return false;

    const existing = await this.farmJobRepo.findOne({ where: { analysisId, type: 'scan.ai' } });
    if (!existing) {
      const asset = await this.assetRepo.findOne({ where: { id: analysis.assetId } });
      if (!asset) throw new Error(`Asset ${analysis.assetId} not found`);
      const keyframes = (analysis.keyframes ?? []) as unknown as StoredKeyframe[];
      const technical = (analysis.technical ?? {}) as { has_speech_hint?: boolean | null };
      const payload = ScanAiPayloadSchema.parse({
        asset_id: asset.id,
        model: this.config.get<string>('ANALYSIS_MODEL') ?? 'qwen2.5vl:7b',
        prompt_version: analysis.promptVersion,
        context: { asset_name: asset.originalFilename, ...(await this.assetContext(asset.id)) },
        media: {
          duration_ms: analysis.durationMs ?? 0,
          has_audio: analysis.hasAudio ?? false,
          has_speech_hint: technical.has_speech_hint ?? null,
        },
        keyframes: keyframes.map((keyframe) => ({
          input: `artifact:${keyframe.output}`,
          t_ms: keyframe.t_ms,
        })),
      });
      const response = await this.farmClient.submitJob({
        type: 'scan.ai',
        lane: 'batch',
        priority: analysis.priority,
        affinity_key: analysis.id,
        payload,
        max_attempts: 3,
        correlation_id: `${analysis.id}:ai`,
        group_key: analysis.batchId ? batchGroupKey(analysis.batchId) : null,
      });
      await this.recordFarmJob(response.job.id, analysis.id, 'scan.ai');
    }
    await this.analysisRepo.update(analysis.id, { status: 'describing' });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Finish
  // ---------------------------------------------------------------------------

  /**
   * Completes the analysis once the extract result, and the description unless the video was
   * technically dead, are ingested. Safe from any step and several hosts: the row is locked and
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
      if (jobs.find((job) => job.type === 'scan.extract')?.status !== 'ingested') return null;
      const dead = (analysis.technical as { dead?: boolean } | null)?.dead === true;
      if (!dead) {
        if (jobs.find((job) => job.type === 'scan.ai')?.status !== 'ingested') return null;
        if (!analysis.description) return null;
      }

      // Previous current row off first: asset_analyses has a partial unique index on is_current.
      await manager.update(
        AssetAnalysisEntity,
        { assetId: analysis.assetId, isCurrent: true },
        { isCurrent: false },
      );
      const usable = dead ? false : analysis.usable;
      await manager.update(AssetAnalysisEntity, analysisId, {
        status: 'completed',
        isCurrent: true,
        completedAt: new Date(),
        usable,
      });
      await manager.save(
        this.outboxService.create(manager, {
          eventType: 'asset.analysis.completed',
          aggregateType: 'asset_analysis',
          aggregateId: analysisId,
          payload: { analysisId, assetId: analysis.assetId, usable, quality: analysis.quality },
        }),
      );
      return { assetId: analysis.assetId, usable, quality: analysis.quality, dead };
    });
    if (completed) {
      const asset = await this.assetRepo
        .findOne({ where: { id: completed.assetId } })
        .catch(() => null);
      await this.analysisLog.write({
        level: 'info',
        action: 'analysis.completed',
        message: completed.dead
          ? `Completed ${asset?.originalFilename ?? completed.assetId}: technically unusable video, not described`
          : `Completed ${asset?.originalFilename ?? completed.assetId}: ${completed.usable ? 'usable' : 'not usable'}, quality ${completed.quality ?? '-'}`,
        metadata: { analysisId, ...completed },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Pause / resume / cancel one analysis
  // ---------------------------------------------------------------------------

  /** Parks an in-flight analysis and pauses its farm jobs. Returns whether it changed. */
  async pause(analysisId: string, options: { farm?: boolean } = {}): Promise<boolean> {
    const result = await this.analysisRepo
      .createQueryBuilder()
      .update(AssetAnalysisEntity)
      .set({ status: 'paused' })
      .where('id = :id', { id: analysisId })
      .andWhere(`status IN ('queued','extracting','extracted','describing')`)
      .execute();
    if (!result.affected) return false;
    if (options.farm !== false) {
      await this.farmClient.controlJobs('pause', { ids: await this.pendingFarmJobIds(analysisId) });
    }
    return true;
  }

  /**
   * Puts a paused analysis back to work from where it stopped: resumes its paused farm job, or
   * submits the step that was never sent. Returns whether it changed.
   */
  async resume(analysisId: string, options: { farm?: boolean } = {}): Promise<boolean> {
    const analysis = await this.analysisRepo.findOne({ where: { id: analysisId } });
    if (!analysis || analysis.status !== 'paused') return false;
    const jobs = await this.farmJobRepo.find({ where: { analysisId } });
    const extract = jobs.find((job) => job.type === 'scan.extract');
    const ai = jobs.find((job) => job.type === 'scan.ai');

    if (!extract) {
      await this.analysisRepo.update(analysisId, { status: 'queued' });
      await this.submitExtract(analysisId);
      return true;
    }
    if (!extract.ingestedAt) {
      if (options.farm !== false)
        await this.farmClient.controlJobs('resume', { ids: [extract.farmJobId] });
      await this.analysisRepo.update(analysisId, { status: 'extracting' });
      return true;
    }
    const dead = (analysis.technical as { dead?: boolean } | null)?.dead === true;
    if (dead) {
      await this.analysisRepo.update(analysisId, { status: 'extracted' });
      await this.finalizeIfDone(analysisId);
      return true;
    }
    if (!ai) {
      await this.analysisRepo.update(analysisId, { status: 'extracted' });
      await this.submitAi(analysisId);
      return true;
    }
    if (!ai.ingestedAt && options.farm !== false) {
      await this.farmClient.controlJobs('resume', { ids: [ai.farmJobId] });
    }
    await this.analysisRepo.update(analysisId, { status: 'describing' });
    if (ai.ingestedAt) await this.finalizeIfDone(analysisId);
    return true;
  }

  /** Cancels an unfinished analysis and its farm jobs. Returns whether it changed. */
  async cancel(
    analysisId: string,
    reason: string,
    options: { farm?: boolean } = {},
  ): Promise<boolean> {
    const result = await this.analysisRepo
      .createQueryBuilder()
      .update(AssetAnalysisEntity)
      .set({ status: 'cancelled', reason })
      .where('id = :id', { id: analysisId })
      .andWhere('status NOT IN (:...finished)', { finished: FINISHED_STATUSES })
      .execute();
    if (!result.affected) return false;
    if (options.farm !== false) {
      await this.farmClient.controlJobs('cancel', {
        ids: await this.pendingFarmJobIds(analysisId),
      });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Parks the analysis when its batch is paused or cancelled. Returns whether it was held. */
  private async holdForBatch(analysis: AssetAnalysisEntity): Promise<boolean> {
    if (!analysis.batchId) return false;
    const batch = await this.batchRepo.findOne({ where: { id: analysis.batchId } });
    if (!batch || batch.status === 'running') return false;
    if (batch.status === 'paused') {
      await this.analysisRepo.update(analysis.id, { status: 'paused' });
    } else {
      await this.analysisRepo.update(analysis.id, {
        status: 'cancelled',
        reason: 'Batch cancelled',
      });
    }
    return true;
  }

  private async pendingFarmJobIds(analysisId: string): Promise<string[]> {
    const rows = await this.farmJobRepo.find({ where: { analysisId, ingestedAt: IsNull() } });
    return rows.map((row) => row.farmJobId);
  }

  /** Records a submitted farm job; a second submission of the same job is ignored. */
  async recordFarmJob(
    farmJobId: string,
    analysisId: string,
    type: string,
    chunk: number | null = null,
  ): Promise<void> {
    await this.farmJobRepo
      .createQueryBuilder()
      .insert()
      .into(AnalysisFarmJobEntity)
      .values({ farmJobId, analysisId, type, chunk, status: 'submitted' })
      .orIgnore()
      .execute();
  }

  /** Hints for the vision model: the names of the asset's projects, categories and provinces. */
  private async assetContext(assetId: string): Promise<{
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
