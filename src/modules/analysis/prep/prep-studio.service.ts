import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { AssetPrepFarmJobEntity } from '../../../database/entities/asset-prep-farm-job.entity';
import {
  AssetPrepEntity,
  PREP_UNFINISHED_STATUSES,
  type PrepTranscript,
} from '../../../database/entities/asset-prep.entity';
import { AssetEntity } from '../../../database/entities/asset.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../assets/storage/storage-adapter';
import { assetVariantsPrefix } from '../../projects/project-asset-cleanup';
import { FarmClient } from '../farm/farm-client';
import { INTERACTIVE_PREP_PRIORITY, prepPrefix } from './prep-batches';
import { PrepPipelineService } from './prep-pipeline.service';

/** Running preps whose farm job is looked up for the phase and progress, per request. */
const FARM_LOOKUPS = 50;

export type StudioPrepState = 'ready' | 'running' | 'missing' | 'failed';
export type StudioPrepPhase = 'queued' | 'cutting' | 'transcribing';

/** The prep of one footage as AG Studio reads it (H2 contract). */
export type StudioPrepItem = {
  assetId: string;
  state: StudioPrepState;
  phase: StudioPrepPhase | null;
  progress: number | null;
  error: string | null;
  prep: null | {
    prepId: string;
    preparedAt: string;
    durationS: number;
    width: number;
    height: number;
    fps: number | null;
    hasAudio: boolean;
    sourceKind: string;
    watermarked: boolean;
    scene: { threshold: number; minShotS: number; maxShotS: number };
    shots: Array<{ n: number; in: number; out: number; frame: string; url: string }>;
    sheets: Array<{ file: string; shots: number[]; url: string }>;
    transcriptStatus: 'none' | 'skipped' | 'done' | 'failed';
    transcript: PrepTranscript | null;
  };
};

/**
 * What AG Studio reads and asks for (`POST /footage/assets/prep` and `.../prep/run`): the current
 * prep of each footage with signed URLs of its frames and sheets, or how far its prep is; and a
 * prep run on demand, ahead of the backfill. Callers check the footage scope first.
 */
@Injectable()
export class PrepStudioService {
  private readonly logger = new Logger(PrepStudioService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetPrepEntity)
    private readonly prepRepo: Repository<AssetPrepEntity>,
    @InjectRepository(AssetPrepFarmJobEntity)
    private readonly farmJobRepo: Repository<AssetPrepFarmJobEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly farmClient: FarmClient,
    private readonly pipeline: PrepPipelineService,
    private readonly config: ConfigService,
  ) {}

  /** The prep state of each asset, in the order asked. */
  async read(assetIds: string[]): Promise<{ items: StudioPrepItem[] }> {
    const ids = [...new Set(assetIds)];
    const { current, latest } = await this.load(ids);
    const assets = new Map(
      (await this.assetRepo.find({ where: { id: In(ids) } })).map((asset) => [asset.id, asset]),
    );
    const running = ids
      .map((id) => (!current.has(id) ? latest.get(id) : undefined))
      .filter((prep): prep is AssetPrepEntity =>
        Boolean(prep && PREP_UNFINISHED_STATUSES.includes(prep.status)),
      );
    const progress = await this.farmProgress(running);

    const ttl = this.config.get<number>('FARM_URL_TTL_SECONDS') ?? 3600;
    const items: StudioPrepItem[] = [];
    for (const assetId of ids) {
      const ready = current.get(assetId);
      const asset = assets.get(assetId);
      if (ready && asset) {
        items.push(await this.readyItem(ready, asset, ttl));
        continue;
      }
      const prep = latest.get(assetId);
      if (prep && PREP_UNFINISHED_STATUSES.includes(prep.status)) {
        const farm = progress.get(prep.id);
        items.push({
          assetId,
          state: 'running',
          phase: farm?.phase ?? (prep.status as StudioPrepPhase),
          progress: farm?.progress ?? null,
          error: null,
          prep: null,
        });
      } else if (prep?.status === 'failed') {
        items.push({
          assetId,
          state: 'failed',
          phase: null,
          progress: null,
          error: prep.error,
          prep: null,
        });
      } else {
        items.push({
          assetId,
          state: 'missing',
          phase: null,
          progress: null,
          error: null,
          prep: null,
        });
      }
    }
    return { items };
  }

  /**
   * Runs the prep of each asset now: a missing or failed one gets a new prep in the interactive
   * lane; one waiting in the batch lane is raised at the farm (or sent now when it was held); a
   * ready or interactive one is left alone. Answers like `read`.
   */
  async run(assetIds: string[], requestedBy: string | null): Promise<{ items: StudioPrepItem[] }> {
    const ids = [...new Set(assetIds)];
    const { current, latest } = await this.load(ids);
    for (const assetId of ids) {
      if (current.has(assetId)) continue;
      const prep = latest.get(assetId);
      try {
        if (prep && PREP_UNFINISHED_STATUSES.includes(prep.status)) {
          if (prep.lane !== 'interactive') await this.raise(prep);
          continue;
        }
        const prepId = await this.dataSource.transaction((manager) =>
          this.pipeline.enqueueInsideTransaction(
            manager,
            { id: assetId },
            { lane: 'interactive', priority: INTERACTIVE_PREP_PRIORITY, requestedBy },
          ),
        );
        // Sent now; when the farm cannot be reached the outbox event sends it later
        if (prepId)
          await this.pipeline
            .submitPrep(prepId)
            .catch((error: unknown) => this.warn(prepId, error));
      } catch (error) {
        this.warn(prep?.id ?? assetId, error);
      }
    }
    return this.read(ids);
  }

  // ---------------------------------------------------------------------------

  /**
   * Moves a batch prep ahead: its next steps go interactive, its job waiting at the farm is raised,
   * and a step held by a paused batch (or never sent) is sent now outside the batch.
   */
  private async raise(prep: AssetPrepEntity): Promise<void> {
    const pending = await this.farmJobRepo.find({
      where: { prepId: prep.id, ingestedAt: IsNull() },
    });
    await this.prepRepo.update(prep.id, {
      lane: 'interactive',
      priority: INTERACTIVE_PREP_PRIORITY,
      ...(pending.length === 0 ? { batchId: null } : {}),
    });
    if (pending.length === 0) {
      await this.pipeline.advance(prep.id);
      return;
    }
    for (const job of pending) {
      try {
        await this.farmClient.raiseJob(job.farmJobId, {
          lane: 'interactive',
          priority: INTERACTIVE_PREP_PRIORITY,
        });
      } catch (error) {
        // Already running (409) or an older hub (404): the job keeps its place, Studio waits.
        this.logger.warn(
          `Could not raise farm job ${job.farmJobId} of prep ${prep.id}: ${errorMessage(error)}`,
        );
      }
    }
  }

  /** The current prep and the latest prep of each asset. */
  private async load(ids: string[]): Promise<{
    current: Map<string, AssetPrepEntity>;
    latest: Map<string, AssetPrepEntity>;
  }> {
    if (ids.length === 0) return { current: new Map(), latest: new Map() };
    const latestIds = await this.dataSource.query<{ id: string }[]>(
      `SELECT DISTINCT ON (asset_id) id FROM asset_preps
       WHERE asset_id = ANY($1::uuid[])
       ORDER BY asset_id, created_at DESC, id DESC`,
      [ids],
    );
    const [currentRows, latestRows] = await Promise.all([
      this.prepRepo.find({ where: { assetId: In(ids), isCurrent: true } }),
      latestIds.length
        ? this.prepRepo.find({ where: { id: In(latestIds.map((row) => row.id)) } })
        : Promise.resolve([]),
    ]);
    return {
      current: new Map(currentRows.map((prep) => [prep.assetId, prep])),
      latest: new Map(latestRows.map((prep) => [prep.assetId, prep])),
    };
  }

  /**
   * Phase and progress of running preps from their farm job: waiting for a machine is `queued`
   * whatever the step. Unreachable farm or too many preps: the stored status stands.
   */
  private async farmProgress(
    preps: AssetPrepEntity[],
  ): Promise<Map<string, { phase: StudioPrepPhase; progress: number | null }>> {
    const result = new Map<string, { phase: StudioPrepPhase; progress: number | null }>();
    const sent = preps.filter((prep) => prep.status !== 'queued').slice(0, FARM_LOOKUPS);
    if (sent.length === 0 || !this.farmClient.isConfigured) return result;
    const jobs = await this.farmJobRepo.find({
      where: { prepId: In(sent.map((prep) => prep.id)), ingestedAt: IsNull() },
    });
    await Promise.all(
      jobs.map(async (row) => {
        try {
          const job = await this.farmClient.getJob(row.farmJobId);
          const step: StudioPrepPhase = row.type === 'scan.prep' ? 'cutting' : 'transcribing';
          const waiting = job.status === 'queued' || job.status === 'paused';
          result.set(row.prepId, {
            phase: waiting && step === 'cutting' ? 'queued' : step,
            progress:
              !waiting && job.progress_percent !== null
                ? Math.min(1, Math.max(0, job.progress_percent / 100))
                : null,
          });
        } catch {
          // The stored status stands
        }
      }),
    );
    return result;
  }

  private async readyItem(
    prep: AssetPrepEntity,
    asset: AssetEntity,
    ttl: number,
  ): Promise<StudioPrepItem> {
    const prefix = prepPrefix(assetVariantsPrefix(asset.originalStorageKey, asset.id), prep.id);
    const sign = (path: string) =>
      this.storage.getPresignedGetUrl(`${prefix}${path}`, 'image/jpeg', ttl);
    const shots = await Promise.all(
      (prep.shots ?? []).map(async (shot) => ({ ...shot, url: await sign(shot.frame) })),
    );
    const sheets = await Promise.all(
      (prep.sheets ?? []).map(async (sheet) => ({ ...sheet, url: await sign(sheet.file) })),
    );
    const transcriptStatus = prep.transcriptStatus === 'pending' ? 'none' : prep.transcriptStatus;
    return {
      assetId: asset.id,
      state: 'ready',
      phase: null,
      progress: null,
      error: null,
      prep: {
        prepId: prep.id,
        preparedAt: (prep.preparedAt ?? prep.updatedAt).toISOString(),
        durationS: prep.durationS ?? 0,
        width: prep.width ?? 0,
        height: prep.height ?? 0,
        fps: prep.fps,
        hasAudio: prep.hasAudio ?? false,
        sourceKind: prep.sourceKind ?? 'unknown',
        watermarked: prep.watermarked ?? false,
        scene: {
          threshold: prep.scene?.threshold ?? 0.3,
          minShotS: prep.scene?.min_shot_s ?? 1,
          maxShotS: prep.scene?.max_shot_s ?? 20,
        },
        shots,
        sheets,
        transcriptStatus,
        transcript: transcriptStatus === 'done' ? prep.transcript : null,
      },
    };
  }

  private warn(id: string, error: unknown): void {
    this.logger.warn(`Prep run for ${id}: ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
