import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { OutboxService } from '../../../common/outbox.service';
import { AssetAnalysisEntity } from '../../../database/entities/asset-analysis.entity';
import { AssetPrepBatchEntity } from '../../../database/entities/asset-prep-batch.entity';
import { AssetPrepFarmJobEntity } from '../../../database/entities/asset-prep-farm-job.entity';
import {
  AssetPrepEntity,
  PREP_FINISHED_STATUSES,
  PREP_UNFINISHED_STATUSES,
  type PrepLane,
} from '../../../database/entities/asset-prep.entity';
import { AssetEntity } from '../../../database/entities/asset.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../../projects/project-asset-cleanup';
import { AnalysisLogService } from '../analysis-log.service';
import { FarmClient } from '../farm/farm-client';
import { PREP_AUDIO_PATH, ScanPrepPayloadSchema } from '../farm/scan';
import { StudioTranscribePayloadSchema } from '../farm/studio';
import {
  ASSET_PREP_REQUESTED_EVENT,
  PREP_JOB_TYPES,
  PREP_TRANSCRIBE_MODEL,
  prepBatchGroupKey,
  prepPrefix,
} from './prep-batches';

/** scan.prep parameters: AG Studio's scene rules, 480 px frames, sheets of 4 × 4 shots. */
const PREP_PARAMS = {
  scene_threshold: 0.3,
  min_shot_s: 1,
  max_shot_s: 20,
  frame_width: 480,
  sheet_cols: 4,
  sheet_shots: 16,
} as const;

/** The last fields a prep gets when it becomes ready. */
export type PrepFinalPatch = Partial<
  Pick<AssetPrepEntity, 'transcript' | 'transcriptText' | 'transcriptStatus' | 'language' | 'error'>
>;

export type PrepEnqueueOptions = {
  lane: PrepLane;
  priority: number;
  batchId?: string | null;
  requestedBy?: string | null;
  /** Skip an asset that already has a current (ready) prep. Default true. */
  skipIfPrepared?: boolean;
  /** Skip an asset whose prep is still running. Default true. */
  skipIfInFlight?: boolean;
};

/**
 * The prep pipeline (Studio inputs prepared once per footage): enqueue a prep, send scan.prep and
 * then studio.transcribe to the farm, make a prep current once it is ready, and move a prep held
 * by a paused batch on. Results are ingested by `PrepIngestService` from the farm poller.
 *
 * A prep's farm jobs carry its batch's group key (`prep-batch:<id>`), so a backfill is paused,
 * resumed or cancelled at the farm in one call; a paused batch holds the next step here.
 */
@Injectable()
export class PrepPipelineService {
  private readonly logger = new Logger(PrepPipelineService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetPrepEntity)
    private readonly prepRepo: Repository<AssetPrepEntity>,
    @InjectRepository(AssetPrepBatchEntity)
    private readonly batchRepo: Repository<AssetPrepBatchEntity>,
    @InjectRepository(AssetPrepFarmJobEntity)
    private readonly farmJobRepo: Repository<AssetPrepFarmJobEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly farmClient: FarmClient,
    private readonly outboxService: OutboxService,
    private readonly analysisLog: AnalysisLogService,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Enqueue
  // ---------------------------------------------------------------------------

  /** PREP_AUTO_ENQUEUE: new video footage is prepared as soon as it is processed. */
  isAutoEnqueueEnabled(): boolean {
    return this.config.get<boolean>('PREP_AUTO_ENQUEUE') !== false;
  }

  /**
   * Creates a queued prep and its outbox event inside `manager`'s transaction. Returns the new prep
   * id, or null when the asset is skipped (already prepared, or a prep is running).
   */
  async enqueueInsideTransaction(
    manager: EntityManager,
    asset: Pick<AssetEntity, 'id'>,
    options: PrepEnqueueOptions,
  ): Promise<string | null> {
    const { skipIfPrepared = true, skipIfInFlight = true } = options;
    if (skipIfInFlight) {
      const running = await manager.findOne(AssetPrepEntity, {
        where: { assetId: asset.id, status: In(PREP_UNFINISHED_STATUSES) },
        select: { id: true },
      });
      if (running) return null;
    }
    if (skipIfPrepared) {
      const current = await manager.findOne(AssetPrepEntity, {
        where: { assetId: asset.id, isCurrent: true },
        select: { id: true },
      });
      if (current) return null;
    }

    const prepId = uuidv7();
    await manager.insert(AssetPrepEntity, {
      id: prepId,
      assetId: asset.id,
      status: 'queued',
      lane: options.lane,
      priority: options.priority,
      batchId: options.batchId ?? null,
      requestedBy: options.requestedBy ?? null,
      transcriptStatus: 'pending',
    });
    await manager.save(
      this.outboxService.create(manager, {
        eventType: ASSET_PREP_REQUESTED_EVENT,
        aggregateType: 'asset_prep',
        aggregateId: prepId,
        payload: { prepId },
      }),
    );
    return prepId;
  }

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  /**
   * The `asset.prep.requested` outbox event. Throws on failure so the outbox retries; the error
   * is kept on the queued prep meanwhile (only a new text is written).
   */
  async handlePrepRequested(prepId: string): Promise<void> {
    try {
      await this.submitPrep(prepId);
    } catch (error) {
      const reason = `Could not submit to the farm: ${error instanceof Error ? error.message : String(error)}`;
      await this.prepRepo
        .createQueryBuilder()
        .update(AssetPrepEntity)
        .set({ error: reason.slice(0, 4000) })
        .where('id = :id', { id: prepId })
        .andWhere(`status = 'queued'`)
        .andWhere('error IS DISTINCT FROM :reason', { reason: reason.slice(0, 4000) })
        .execute()
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Sends a queued prep to the farm (scan.prep). Idempotent: a prep that is no longer `queued` is
   * left alone and the farm dedupes by correlation id. Throws on farm errors so the outbox retries.
   */
  async submitPrep(prepId: string): Promise<void> {
    if (!this.farmClient.isConfigured) {
      throw new Error('FARM_URL is not configured — cannot submit scan.prep job');
    }
    const prep = await this.prepRepo.findOne({ where: { id: prepId } });
    if (!prep) throw new Error(`Prep ${prepId} not found`);
    if (prep.status !== 'queued') return;
    if (await this.holdForBatch(prep)) return;

    const existing = await this.farmJobRepo.findOne({
      where: { prepId, type: PREP_JOB_TYPES.prep },
    });
    if (!existing) {
      const analysis = await this.analysisRepo.findOne({
        where: { assetId: prep.assetId, isCurrent: true },
        select: { id: true, hasAudio: true, hasSpeech: true },
      });
      // No audio.wav when the analysis already found no sound or no speech: nothing to transcribe
      const audio = !(analysis?.hasAudio === false || analysis?.hasSpeech === false);
      const payload = ScanPrepPayloadSchema.parse({
        asset_id: prep.assetId,
        source: 'source',
        params: { ...PREP_PARAMS, audio },
      });
      const response = await this.farmClient.submitJob({
        type: 'scan.prep',
        lane: prep.lane,
        priority: prep.priority,
        affinity_key: prep.id,
        payload,
        max_attempts: 3,
        correlation_id: `${prep.id}:prep`,
        group_key: prep.batchId ? prepBatchGroupKey(prep.batchId) : null,
      });
      await this.recordFarmJob(response.job.id, prep.id, PREP_JOB_TYPES.prep);
    }
    await this.prepRepo.update(
      { id: prep.id, status: 'queued' },
      { status: 'cutting', error: null },
    );
  }

  /** Sends the transcript job (studio.transcribe) of a prep whose scan.prep wrote audio.wav. */
  async submitTranscribe(prepId: string): Promise<void> {
    const prep = await this.prepRepo.findOne({ where: { id: prepId } });
    if (!prep) throw new Error(`Prep ${prepId} not found`);
    if (PREP_FINISHED_STATUSES.includes(prep.status)) return;

    const existing = await this.farmJobRepo.findOne({
      where: { prepId, type: PREP_JOB_TYPES.transcribe },
    });
    if (!existing) {
      const payload = StudioTranscribePayloadSchema.parse({
        production_id: prep.id,
        model: PREP_TRANSCRIBE_MODEL,
        align_words: true,
        sources: [
          { source_id: prep.assetId, audio: `artifact:${PREP_AUDIO_PATH}`, language: null },
        ],
      });
      const response = await this.farmClient.submitJob({
        type: 'studio.transcribe',
        lane: prep.lane,
        priority: prep.priority,
        affinity_key: prep.id,
        payload,
        max_attempts: 3,
        correlation_id: `${prep.id}:transcribe`,
        group_key: prep.batchId ? prepBatchGroupKey(prep.batchId) : null,
      });
      await this.recordFarmJob(response.job.id, prep.id, PREP_JOB_TYPES.transcribe);
    }
    await this.prepRepo.update(prep.id, { status: 'transcribing' });
  }

  /**
   * Moves an unfinished prep on from where it stopped, for a resumed batch or a prep AG Studio
   * asks for: sends scan.prep when it was never sent, or the transcript job when the shots are in
   * but the transcript was held. A step already at the farm is left to the farm.
   */
  async advance(prepId: string): Promise<void> {
    const prep = await this.prepRepo.findOne({ where: { id: prepId } });
    if (!prep || !PREP_UNFINISHED_STATUSES.includes(prep.status)) return;
    const jobs = await this.farmJobRepo.find({ where: { prepId } });
    const cut = jobs.find((job) => job.type === PREP_JOB_TYPES.prep);
    if (!cut) {
      if (prep.status !== 'queued') await this.prepRepo.update(prep.id, { status: 'queued' });
      await this.submitPrep(prep.id);
      return;
    }
    const transcribe = jobs.find((job) => job.type === PREP_JOB_TYPES.transcribe);
    if (cut.ingestedAt && !transcribe && prep.transcriptStatus === 'pending' && prep.shots) {
      if (await this.holdForBatch(prep)) return;
      await this.submitTranscribe(prep.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Finish
  // ---------------------------------------------------------------------------

  /**
   * Makes the prep ready and the asset's current one, with the last fields (`patch`). Safe from
   * several hosts: the row is locked and re-checked, so it completes once. Returns whether it did.
   */
  async finalize(prepId: string, patch: PrepFinalPatch): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const prep = await manager.findOne(AssetPrepEntity, {
        where: { id: prepId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!prep || PREP_FINISHED_STATUSES.includes(prep.status)) return false;
      // Previous current row off first: asset_preps has a partial unique index on is_current.
      await manager.update(
        AssetPrepEntity,
        { assetId: prep.assetId, isCurrent: true },
        { isCurrent: false },
      );
      await manager.update(AssetPrepEntity, prepId, {
        ...patch,
        status: 'ready',
        isCurrent: true,
        preparedAt: new Date(),
      });
      return true;
    });
  }

  /** Fails an unfinished prep (the first reason is kept). Returns whether it changed. */
  async fail(prepId: string, reason: string): Promise<boolean> {
    const result = await this.prepRepo
      .createQueryBuilder()
      .update(AssetPrepEntity)
      .set({ status: 'failed', error: reason.slice(0, 4000) })
      .where('id = :id', { id: prepId })
      .andWhere('status IN (:...unfinished)', { unfinished: PREP_UNFINISHED_STATUSES })
      .execute();
    return Boolean(result.affected);
  }

  /** Removes the audio track scan.prep wrote for the transcript; a missing file is fine. */
  async deleteAudio(prep: Pick<AssetPrepEntity, 'id' | 'assetId'>): Promise<void> {
    try {
      const asset = await this.assetRepo.findOne({ where: { id: prep.assetId } });
      if (!asset) return;
      const prefix = prepPrefix(assetVariantsPrefix(asset.originalStorageKey, asset.id), prep.id);
      await this.storage.deleteObject(`${prefix}${PREP_AUDIO_PATH}`);
    } catch (error) {
      this.logger.warn(
        `Could not delete audio.wav of prep ${prep.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Holds the prep when its batch is paused (it stays as it is until the batch resumes) or
   * cancels it when the batch is cancelled. Returns whether it was held.
   */
  async holdForBatch(prep: AssetPrepEntity): Promise<boolean> {
    if (!prep.batchId) return false;
    const batch = await this.batchRepo.findOne({ where: { id: prep.batchId } });
    if (!batch || batch.status === 'running') return false;
    if (batch.status === 'cancelled') {
      await this.prepRepo
        .createQueryBuilder()
        .update(AssetPrepEntity)
        .set({ status: 'cancelled', error: 'Batch cancelled' })
        .where('id = :id', { id: prep.id })
        .andWhere('status IN (:...unfinished)', { unfinished: PREP_UNFINISHED_STATUSES })
        .execute();
    }
    return true;
  }

  /** Farm jobs of the prep still waiting for a result. */
  async pendingFarmJobs(prepId: string): Promise<AssetPrepFarmJobEntity[]> {
    return this.farmJobRepo.find({ where: { prepId, ingestedAt: IsNull() } });
  }

  /** Records a submitted farm job; a second submission of the same job is ignored. */
  async recordFarmJob(farmJobId: string, prepId: string, type: string): Promise<void> {
    await this.farmJobRepo
      .createQueryBuilder()
      .insert()
      .into(AssetPrepFarmJobEntity)
      .values({ farmJobId, prepId, type, status: 'submitted' })
      .orIgnore()
      .execute();
  }

  /** Writes a line to the processing log of the analysis page (never throws). */
  async log(
    level: 'info' | 'warn' | 'error',
    action: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.analysisLog.write({ level, action, message, metadata });
  }
}
