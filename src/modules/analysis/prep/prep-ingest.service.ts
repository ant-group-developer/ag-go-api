import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetAnalysisEntity } from '../../../database/entities/asset-analysis.entity';
import { AssetPrepFarmJobEntity } from '../../../database/entities/asset-prep-farm-job.entity';
import {
  AssetPrepEntity,
  PREP_FINISHED_STATUSES,
  type PrepTranscript,
  type PrepTranscriptStatus,
} from '../../../database/entities/asset-prep.entity';
import { AssetEntity } from '../../../database/entities/asset.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../../projects/project-asset-cleanup';
import { FarmClient } from '../farm/farm-client';
import type { ListedJob } from '../farm/protocol';
import { PREP_MANIFEST_PATH, ScanPrepManifestSchema, type ScanPrepManifest } from '../farm/scan';
import {
  TRANSCRIBE_MANIFEST_PATH,
  TranscribeManifestSchema,
  type TranscribeManifest,
} from '../farm/studio';
import { PREP_CORRELATION_PATTERN, PREP_JOB_TYPES, prepPrefix } from './prep-batches';
import { PrepPipelineService } from './prep-pipeline.service';

/** How long one outbox host may hold a farm result while ingesting it. */
const PROCESSING_LOCK_SECONDS = 300;

type LoadedPrep = { prep: AssetPrepEntity; asset: AssetEntity; prefix: string };

/**
 * Ingests the farm results of preps for the farm poller: scan.prep (shots, frames, sheets, media)
 * then studio.transcribe (the transcript). Every step is idempotent and each result is locked
 * while one outbox host ingests it, like the analysis results.
 */
@Injectable()
export class PrepIngestService {
  private readonly logger = new Logger(PrepIngestService.name);

  constructor(
    @InjectRepository(AssetPrepEntity)
    private readonly prepRepo: Repository<AssetPrepEntity>,
    @InjectRepository(AssetPrepFarmJobEntity)
    private readonly farmJobRepo: Repository<AssetPrepFarmJobEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly farmClient: FarmClient,
    private readonly pipeline: PrepPipelineService,
  ) {}

  /**
   * Ingests one finished farm job if it belongs to a prep. Returns null when it does not (the
   * caller tries the other pipelines), else whether it may be acked.
   */
  async processJob(job: ListedJob): Promise<boolean | null> {
    const row = await this.findOrAdoptFarmJob(job);
    if (!row) return null;
    if (row.ingestedAt) return true;
    if (!(await this.lock(row.farmJobId))) return false;

    try {
      if (job.status === 'failed' || job.status === 'cancelled') {
        await this.handleFailed(row, job);
      } else if (job.status !== 'completed') {
        this.logger.warn(`Farm job ${job.id} has unexpected status ${job.status} — skipping`);
        return false;
      } else if (row.type === PREP_JOB_TYPES.prep) {
        await this.handlePrepCompleted(row);
      } else if (row.type === PREP_JOB_TYPES.transcribe) {
        await this.handleTranscribeCompleted(row);
      } else {
        await this.markIngested(row, 'ingested');
      }
      return true;
    } finally {
      await this.farmJobRepo.update(row.farmJobId, { lockedUntil: null });
    }
  }

  // ---------------------------------------------------------------------------
  // scan.prep completed
  // ---------------------------------------------------------------------------

  private async handlePrepCompleted(row: AssetPrepFarmJobEntity): Promise<void> {
    const loaded = await this.loadPrep(row);
    if (!loaded || PREP_FINISHED_STATUSES.includes(loaded.prep.status)) {
      await this.markIngested(row, 'ingested');
      return;
    }
    const { prep, asset, prefix } = loaded;

    let manifest: ScanPrepManifest;
    try {
      manifest = ScanPrepManifestSchema.parse(
        JSON.parse(await this.storage.getObjectText(`${prefix}${PREP_MANIFEST_PATH}`)),
      );
      if (manifest.asset_id !== asset.id) {
        throw new Error(`manifest is for asset ${manifest.asset_id}`);
      }
    } catch (error) {
      await this.failPrep(row, `Failed to read ${PREP_MANIFEST_PATH}: ${errorMessage(error)}`);
      return;
    }

    const transcript = await this.transcriptPlan(asset.id, manifest);
    await this.prepRepo.update(prep.id, {
      durationS: manifest.media.duration_s,
      width: manifest.media.width,
      height: manifest.media.height,
      fps: manifest.media.fps,
      hasAudio: manifest.media.has_audio,
      scene: manifest.scene,
      shots: manifest.shots,
      sheets: manifest.sheets,
    });

    if (transcript === 'transcribe') {
      // Sent before the result counts as ingested: a failure throws, the result is not acked and
      // the next poll sends again (the farm dedupes). A paused batch holds it until it resumes.
      if (!(await this.pipeline.holdForBatch(prep))) {
        await this.pipeline.submitTranscribe(prep.id);
      }
      await this.markIngested(row, 'ingested');
      return;
    }

    await this.markIngested(row, 'ingested');
    if (manifest.audio) await this.pipeline.deleteAudio(prep);
    await this.pipeline.finalize(prep.id, {
      transcriptStatus: transcript.status,
      ...(transcript.error ? { error: transcript.error } : {}),
    });
  }

  /**
   * Whether the prep goes on to the transcript: not without sound, and not when the analysis found
   * no speech (`skipped`, Studio does the same).
   */
  private async transcriptPlan(
    assetId: string,
    manifest: ScanPrepManifest,
  ): Promise<'transcribe' | { status: PrepTranscriptStatus; error?: string }> {
    if (!manifest.media.has_audio) return { status: 'none' };
    const analysis = await this.analysisRepo.findOne({
      where: { assetId, isCurrent: true },
      select: { id: true, hasSpeech: true },
    });
    if (analysis?.hasSpeech === false) return { status: 'skipped' };
    if (!manifest.audio) {
      return { status: 'failed', error: 'scan.prep found sound but wrote no audio track' };
    }
    return 'transcribe';
  }

  // ---------------------------------------------------------------------------
  // studio.transcribe completed
  // ---------------------------------------------------------------------------

  private async handleTranscribeCompleted(row: AssetPrepFarmJobEntity): Promise<void> {
    const loaded = await this.loadPrep(row);
    if (!loaded || PREP_FINISHED_STATUSES.includes(loaded.prep.status)) {
      await this.markIngested(row, 'ingested');
      return;
    }
    const { prep, asset, prefix } = loaded;

    let manifest: TranscribeManifest;
    try {
      manifest = TranscribeManifestSchema.parse(
        JSON.parse(await this.storage.getObjectText(`${prefix}${TRANSCRIBE_MANIFEST_PATH}`)),
      );
    } catch (error) {
      await this.transcriptFailed(
        row,
        prep,
        `Failed to read ${TRANSCRIBE_MANIFEST_PATH}: ${errorMessage(error)}`,
      );
      return;
    }
    const source =
      manifest.sources.find((s) => s.source_id === asset.id) ?? manifest.sources[0] ?? null;
    if (!source) {
      await this.transcriptFailed(row, prep, `${TRANSCRIBE_MANIFEST_PATH} has no source`);
      return;
    }

    const transcript: PrepTranscript = {
      language: source.language,
      alignment: source.alignment,
      engine: manifest.engine.name,
      segments: source.segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        words: segment.words,
      })),
    };
    const text = source.segments
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(' ');
    await this.pipeline.finalize(prep.id, {
      transcript,
      transcriptText: text || null,
      transcriptStatus: 'done',
      language: source.language,
    });
    await this.markIngested(row, 'ingested');
    await this.pipeline.deleteAudio(prep);
  }

  /** The transcript is an extra: the prep is still made ready, with `transcript_status = failed`. */
  private async transcriptFailed(
    row: AssetPrepFarmJobEntity,
    prep: AssetPrepEntity,
    reason: string,
  ): Promise<void> {
    await this.farmJobRepo.update(row.farmJobId, { error: { reason } });
    await this.pipeline.finalize(prep.id, { transcriptStatus: 'failed', error: reason });
    await this.markIngested(row, 'failed');
    await this.pipeline.deleteAudio(prep);
    await this.pipeline.log(
      'warn',
      'prep.transcribe_failed',
      `${await this.assetLabel(prep.assetId)}: transcript failed — ${reason}`,
      {
        prepId: prep.id,
        assetId: prep.assetId,
        farmJobId: row.farmJobId,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Failed
  // ---------------------------------------------------------------------------

  private async handleFailed(row: AssetPrepFarmJobEntity, job: ListedJob): Promise<void> {
    const reason = job.error
      ? `Farm job ${job.status}: ${job.error.code} — ${job.error.message}`
      : `Farm job ${job.status}`;
    if (row.type === PREP_JOB_TYPES.transcribe) {
      const prep = await this.prepRepo.findOne({ where: { id: row.prepId } });
      if (prep && !PREP_FINISHED_STATUSES.includes(prep.status)) {
        await this.transcriptFailed(row, prep, reason);
      } else {
        await this.markIngested(row, 'failed');
      }
      return;
    }
    await this.failPrep(row, reason);
  }

  private async failPrep(row: AssetPrepFarmJobEntity, reason: string): Promise<void> {
    const failed = await this.pipeline.fail(row.prepId, reason);
    await this.farmJobRepo.update(row.farmJobId, { error: { reason } });
    await this.markIngested(row, 'failed');
    // The prep cannot complete any more: stop what is still waiting at the farm.
    for (const sibling of await this.pipeline.pendingFarmJobs(row.prepId)) {
      await this.cancelFarmJob(sibling.farmJobId);
    }
    if (failed) {
      const prep = await this.prepRepo.findOne({ where: { id: row.prepId } });
      this.logger.warn(`Prep ${row.prepId} failed: ${reason}`);
      await this.pipeline.log(
        'error',
        'prep.failed',
        `${await this.assetLabel(prep?.assetId ?? null)}: ${row.type} failed — ${reason}`,
        {
          prepId: row.prepId,
          assetId: prep?.assetId ?? null,
          farmJobId: row.farmJobId,
          type: row.type,
        },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** The local row of a prep farm job, recreated from its correlation id when it is missing. */
  private async findOrAdoptFarmJob(job: ListedJob): Promise<AssetPrepFarmJobEntity | null> {
    const row = await this.farmJobRepo.findOne({ where: { farmJobId: job.id } });
    if (row) return row;
    const match = PREP_CORRELATION_PATTERN.exec(job.correlation_id);
    if (!match) return null;
    const [, prepId, kind] = match as unknown as [string, string, 'prep' | 'transcribe'];
    if (!(await this.prepRepo.count({ where: { id: prepId } }))) return null;
    await this.pipeline.recordFarmJob(job.id, prepId, PREP_JOB_TYPES[kind]);
    return this.farmJobRepo.findOne({ where: { farmJobId: job.id } });
  }

  /** Takes the processing lock; false when another host holds it or the result is ingested. */
  private async lock(farmJobId: string): Promise<boolean> {
    const result = await this.farmJobRepo
      .createQueryBuilder()
      .update(AssetPrepFarmJobEntity)
      .set({ lockedUntil: () => `now() + interval '${PROCESSING_LOCK_SECONDS} seconds'` })
      .where('farm_job_id = :farmJobId', { farmJobId })
      .andWhere('ingested_at IS NULL')
      .andWhere('(locked_until IS NULL OR locked_until < now())')
      .execute();
    return Boolean(result.affected);
  }

  private async markIngested(
    row: AssetPrepFarmJobEntity,
    status: 'ingested' | 'failed',
  ): Promise<void> {
    await this.farmJobRepo.update(row.farmJobId, { status, ingestedAt: new Date() });
  }

  private async loadPrep(row: AssetPrepFarmJobEntity): Promise<LoadedPrep | null> {
    const prep = await this.prepRepo.findOne({ where: { id: row.prepId } });
    if (!prep) return null;
    const asset = await this.assetRepo.findOne({ where: { id: prep.assetId } });
    if (!asset) return null;
    const prefix = prepPrefix(assetVariantsPrefix(asset.originalStorageKey, asset.id), prep.id);
    return { prep, asset, prefix };
  }

  private async cancelFarmJob(farmJobId: string): Promise<void> {
    await this.farmClient.cancelJob(farmJobId).catch((error: unknown) => {
      this.logger.warn(`Could not cancel farm job ${farmJobId}: ${errorMessage(error)}`);
    });
  }

  /** The asset's file name for a log message, or its id when it cannot be read. */
  private async assetLabel(assetId: string | null): Promise<string> {
    if (!assetId) return 'Unknown asset';
    const asset = await this.assetRepo.findOne({ where: { id: assetId } }).catch(() => null);
    return asset?.originalFilename ?? assetId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
