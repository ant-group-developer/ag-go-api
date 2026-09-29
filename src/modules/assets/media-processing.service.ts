import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import ffmpegPath from 'ffmpeg-static';
import { path as ffprobePath } from 'ffprobe-static';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, promises as fs, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { In, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import {
  MediaRenderJobEntity,
  type RenderSummary,
} from '../../database/entities/media-render-job.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { refreshRenderBatch } from '../render/render-job-lifecycle';
import {
  normalizeRenderSizes,
  planPreviewVariants,
  type RenderSizes,
} from '../render/render-sizes';
import { normalizeWatermarkConfig, type WatermarkConfig } from '../render/watermark-config';
import {
  clipToFrame,
  getOverlayPosition,
  getRotatedSize,
  getSingleWatermarkTileScale,
  getWatermarkMargin,
  getWatermarkTileGeometry,
  getWatermarkUnitScale,
} from '../render/watermark-layout';
import {
  findActiveRenderProfile,
  isWatermarkActive,
  THUMBNAIL_VARIANT_CODE,
  watermarkFingerprint,
} from '../render/watermark-policy';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage/storage-adapter';

type ProgressReporter = (percent: number, message: string) => Promise<void>;

type MediaMetadata = {
  width?: number;
  height?: number;
  durationSeconds?: number;
  format?: string;
  codec?: string;
  frameRate?: number;
};

/** One variant a render of a file should end with, and the spec it is rendered with. */
type PlannedOutput = {
  kind: 'preview' | 'thumbnail';
  variantCode: string;
  /** Short edge of a preview; 0 for the thumbnail. */
  resolution: number;
  /** Frame of a preview; the thumbnail's maximum width (its height follows the ratio, 0 here). */
  width: number;
  height: number;
  watermark: boolean;
  /** Target bitrate of a video preview; null for constant quality and for images. */
  bitrate: number | null;
  renderSpec: string;
};

type RenderResult = { metadata: MediaMetadata; summary: RenderSummary };

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** How much of a failed FFmpeg run's stderr is kept as the job's error message. */
const STDERR_TAIL_CHARS = 2000;

/** How often a running job refreshes its updated_at. */
const JOB_HEARTBEAT_MS = 30_000;

/** How often a running job checks whether it was cancelled (e.g. superseded by a newer render). */
const CANCEL_CHECK_MS = 5_000;

/** A `processing` job with no heartbeat for this long has lost its worker. */
const STALE_JOB_MS = 3 * 60_000;

/**
 * STALE_JOB_MS as a Postgres interval. Staleness is compared with NOW() on the database, the
 * clock the heartbeat writes with, so workers on hosts whose clocks drift agree on it.
 */
const STALE_JOB_INTERVAL = `${STALE_JOB_MS} milliseconds`;

/** Every temp file a render writes starts with this, so leftovers can be found by name. */
const TEMP_FILE_PREFIX = 'ag-go-';

/** FFmpeg reports its position on stdout (about twice a second) and keeps stderr for errors. */
const FFMPEG_PROGRESS_ARGS = ['-nostdin', '-nostats', '-progress', 'pipe:1'];

/** A preview render whose position has not moved for this long is stuck, however long it ran. */
const RENDER_STALL_MS = 2 * 60_000;

/**
 * Total preview render budget per second of source. 4K60 10-bit HEVC to 1920px took about
 * 8 s per source second with two renders sharing 2 CPUs.
 */
const RENDER_SECONDS_PER_SOURCE_SECOND = 20;

const STALL_CHECK_MS = 5_000;

/** Share of a video job's render progress given to the (quick) thumbnail step. */
const VIDEO_THUMBNAIL_SHARE = 0.1;

/** Minimum gap between job progress writes while a preview renders. */
const PROGRESS_REPORT_INTERVAL_MS = 5_000;

/** Thrown inside a render whose job was cancelled; the job is left as `cancelled`. */
class RenderJobCancelledError extends Error {
  constructor() {
    super('Render job was cancelled');
  }
}

/**
 * The job a render call chain belongs to, and the token this worker run claimed it with; lets
 * deep helpers stop when the job is cancelled or re-claimed by another worker.
 */
type ActiveRender = { jobId: string; claimToken: string; controller: AbortController };

type RunProcessOptions = {
  /** Total run time limit; defaults to MEDIA_RENDER_TIMEOUT_SECONDS. */
  timeoutMs?: number;
  /**
   * For FFmpeg run with FFMPEG_PROGRESS_ARGS: kill it once its position has not advanced for
   * this long, and pass each new position (seconds of output written) to `onProgress`.
   */
  stallMs?: number;
  onProgress?: (outputSeconds: number) => void;
};

@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);
  private readonly activeRender = new AsyncLocalStorage<ActiveRender>();

  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepository: Repository<AssetVariantEntity>,
    @InjectRepository(MediaRenderJobEntity)
    private readonly jobRepository: Repository<MediaRenderJobEntity>,
    @InjectRepository(RenderProfileEntity)
    private readonly renderProfileRepository: Repository<RenderProfileEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly config: ConfigService,
  ) {}

  async processJobById(jobId: string, assetId: string, queueJobId?: string): Promise<void> {
    const job = await this.jobRepository.findOne({ where: { id: jobId, assetId } });
    if (!job) {
      // Deleted with its asset (e.g. its project was deleted): nothing to render, and a throw
      // would only make BullMQ retry it.
      this.logger.warn(`Render job ${jobId} no longer exists, skipped`);
      return;
    }

    // Only one worker's UPDATE can move the job out of queued/failed; the token marks which.
    // Jobs of a paused batch are not claimed: they stay queued and get a new BullMQ job when
    // the batch is resumed (see RenderService.resumeBatch).
    const claimToken = uuidv7();
    const claimed = await this.jobRepository
      .createQueryBuilder()
      .update(MediaRenderJobEntity)
      .set({
        status: 'processing',
        claimToken,
        progressPercent: 5,
        progressMessage: 'Reading original object',
        startedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        attemptCount: () => 'attempt_count + 1',
      })
      .where(
        `id = :id AND status IN (:...statuses) AND NOT EXISTS (
          SELECT 1 FROM render_batches batch
          WHERE batch.id = media_render_jobs.render_batch_id AND batch.status = 'paused'
        )`,
        { id: job.id, statuses: ['queued', 'failed'] },
      )
      .execute();
    if (!claimed.affected) {
      return;
    }
    const render: ActiveRender = { jobId: job.id, claimToken, controller: new AbortController() };
    // Keeps updated_at fresh while this worker is alive, so recoverStaleJobs can tell a
    // long FFmpeg run from a job whose worker died.
    const heartbeat = setInterval(() => void this.touchJob(render), JOB_HEARTBEAT_MS);
    // A newer render of the same file cancels this job (see cancelSupersededRenderJobs), and a
    // job re-queued as stale may be claimed by another worker; stop FFmpeg in both cases
    // instead of rendering previews that would be thrown away or overwrite the new owner's.
    const cancelWatch = setInterval(() => void this.watchJob(render), CANCEL_CHECK_MS);
    try {
      await this.activeRender.run(render, () =>
        this.runClaimedJob(job, assetId, render, queueJobId),
      );
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancelWatch);
    }
  }

  /**
   * Handles `processing` jobs whose worker stopped heartbeating (killed for memory, restarted
   * by a deploy). Their BullMQ job is gone or cannot re-claim them, so without this they stay
   * `processing` forever. Jobs that already used every attempt fail; the rest go back to
   * `queued` and are returned for the caller to re-enqueue. Clearing the claim token makes a
   * worker that was only slow, not dead, stop at its next check instead of rendering on.
   */
  async recoverStaleJobs(): Promise<Array<{ id: string; assetId: string }>> {
    const stale = 'status = :status AND updated_at < NOW() - CAST(:staleAfter AS interval)';
    const maxAttempts = this.config.getOrThrow<number>('MEDIA_JOB_ATTEMPTS');
    const exhausted = await this.jobRepository
      .createQueryBuilder()
      .update(MediaRenderJobEntity)
      .set({
        status: 'failed',
        claimToken: null,
        progressMessage: 'Media processing failed',
        errorCode: 'WORKER_LOST',
        errorMessage:
          'The worker stopped while processing this file (it may have run out of memory)',
        finishedAt: new Date(),
      })
      .where(`${stale} AND attempt_count >= :maxAttempts`, {
        status: 'processing',
        staleAfter: STALE_JOB_INTERVAL,
        maxAttempts,
      })
      .returning(['id', 'assetId', 'renderBatchId'])
      .execute();
    const failedRows = exhausted.raw as Array<{ asset_id: string; render_batch_id: string | null }>;
    for (const row of failedRows) {
      await this.assetRepository.update(row.asset_id, {
        processingStatus: 'failed',
        processingError: 'The worker stopped while processing this file',
      });
    }
    for (const batchId of new Set(failedRows.map((row) => row.render_batch_id))) {
      await refreshRenderBatch(this.jobRepository.manager, batchId);
    }

    const requeued = await this.jobRepository
      .createQueryBuilder()
      .update(MediaRenderJobEntity)
      .set({
        status: 'queued',
        claimToken: null,
        progressPercent: 0,
        progressMessage: 'Queued again after the worker stopped',
      })
      .where(stale, { status: 'processing', staleAfter: STALE_JOB_INTERVAL })
      .returning(['id', 'assetId'])
      .execute();
    const requeuedRows = requeued.raw as Array<{ id: string; asset_id: string }>;
    if (failedRows.length > 0 || requeuedRows.length > 0) {
      this.logger.warn(
        `Recovered stale render jobs: ${requeuedRows.length} re-queued, ${failedRows.length} failed`,
      );
    }
    return requeuedRows.map((row) => ({ id: row.id, assetId: row.asset_id }));
  }

  /**
   * Deletes render temp files left behind when the worker process died mid-job (the
   * `finally` that removes them never ran), which can be hundreds of MB per 4K source.
   * Synchronous and only called before the worker takes jobs, so it cannot delete a file a
   * running render still needs.
   */
  removeLeftoverTempFiles(): void {
    const dir = tmpdir();
    let removed = 0;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(TEMP_FILE_PREFIX)) {
        continue;
      }
      try {
        rmSync(join(dir, name), { force: true, recursive: true });
        removed += 1;
      } catch (error) {
        this.logger.warn(
          `Temp file ${name} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (removed > 0) {
      this.logger.warn(`Removed ${removed} temp files left by an interrupted render`);
    }
  }

  /** Marks a job re-queued by recoverStaleJobs as failed when it could not be enqueued. */
  async failUnqueuedJob(jobId: string, message: string): Promise<void> {
    await this.jobRepository.update(
      { id: jobId, status: 'queued' },
      {
        status: 'failed',
        progressMessage: 'Media processing failed',
        errorCode: 'ENQUEUE_FAILED',
        errorMessage: message.slice(0, 4000),
        finishedAt: new Date(),
      },
    );
  }

  /**
   * Where-criteria matching the job only while this worker run still holds it: not cancelled,
   * and not re-queued as stale and claimed by another worker meanwhile.
   */
  private ownedJob(render: ActiveRender) {
    return { id: render.jobId, status: 'processing' as const, claimToken: render.claimToken };
  }

  private async touchJob(render: ActiveRender): Promise<void> {
    try {
      await this.jobRepository
        .createQueryBuilder()
        .update(MediaRenderJobEntity)
        .set({ updatedAt: () => 'NOW()' })
        .where('id = :id AND status = :status AND claim_token = :claimToken', this.ownedJob(render))
        .execute();
    } catch (error) {
      this.logger.warn(
        `Render job ${render.jobId} heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async runClaimedJob(
    job: MediaRenderJobEntity,
    assetId: string,
    render: ActiveRender,
    queueJobId?: string,
  ): Promise<void> {
    if (queueJobId) {
      await this.jobRepository.update(this.ownedJob(render), { queueJobId });
    }

    try {
      const asset = await this.assetRepository.findOne({ where: { id: assetId } });
      if (!asset) {
        throw new Error('Asset not found');
      }
      const original = await this.storage.headObject(asset.originalStorageKey);
      if (!original) {
        throw new Error('Original object not found');
      }
      const profile = job.renderProfileId
        ? await this.renderProfileRepository.findOne({ where: { id: job.renderProfileId } })
        : await findActiveRenderProfile(this.renderProfileRepository);

      // When every variant the profile asks for already exists, the original is not needed.
      const reusedAll = job.reuseExisting ? await this.reuseMatchingVariants(asset, profile) : null;
      const result =
        reusedAll ?? (await this.renderFromOriginal(asset, profile, render, job.reuseExisting));

      await this.jobRepository.manager.transaction(async (manager) => {
        // Job first: its row lock holds off a cancel or stale sweep until the asset is ready
        // too, and a job no longer held leaves the asset to the render that holds it.
        const completed = await manager.update(MediaRenderJobEntity, this.ownedJob(render), {
          status: 'completed',
          progressPercent: 100,
          progressMessage: reusedAll
            ? 'Existing media variants reused'
            : 'Media variants are ready',
          renderSummary: result.summary,
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        });
        if (!completed.affected) {
          throw new RenderJobCancelledError();
        }
        await manager.update(AssetEntity, asset.id, {
          processingStatus: 'ready',
          processingError: null,
          sourceMetadata: {
            ...(asset.sourceMetadata ?? {}),
            ...result.metadata,
          },
        });
      });
      await refreshRenderBatch(this.jobRepository.manager, job.renderBatchId);
    } catch (error) {
      if (
        error instanceof RenderJobCancelledError ||
        this.activeRender.getStore()?.controller.signal.aborted
      ) {
        // The job stays `cancelled` (or with the worker that re-claimed it), and the asset
        // belongs to that render. Returning (not throwing) keeps BullMQ from retrying it.
        this.logger.log(
          `Render job ${job.id} was cancelled or claimed by another worker, stopped rendering asset ${assetId}`,
        );
        await refreshRenderBatch(this.jobRepository.manager, job.renderBatchId);
        return;
      }
      const message = error instanceof Error ? error.message : 'Media processing failed';
      this.logger.error(`Asset ${assetId} processing failed: ${message}`);
      // Job first, as on completion: only the run still holding the job marks the asset.
      const held = await this.jobRepository.manager.transaction(async (manager) => {
        const failed = await manager.update(MediaRenderJobEntity, this.ownedJob(render), {
          status: 'failed',
          progressMessage: 'Media processing failed',
          errorCode: 'PROCESSING_FAILED',
          errorMessage: message.slice(0, 4000),
          finishedAt: new Date(),
        });
        if (failed.affected) {
          await manager.update(AssetEntity, assetId, {
            processingStatus: 'failed',
            processingError: message.slice(0, 4000),
          });
        }
        return Boolean(failed.affected);
      });
      await refreshRenderBatch(this.jobRepository.manager, job.renderBatchId);
      if (!held) {
        // Lost the job while failing: another render owns the asset now; nothing to retry.
        this.logger.warn(`Render job ${job.id} is no longer held by this worker, not retried`);
        return;
      }
      throw error;
    }
  }

  /** Downloads the original and renders the variants it is missing (all of them without `reuse`). */
  private async renderFromOriginal(
    asset: AssetEntity,
    profile: RenderProfileEntity | null,
    render: ActiveRender,
    reuse: boolean,
  ): Promise<RenderResult> {
    const tempPath = join(tmpdir(), `${TEMP_FILE_PREFIX}${asset.id}-${Date.now()}`);
    try {
      // The lookups before can be slow; a render that lost the job meanwhile must not flip an
      // asset another render already made `ready` back to `processing`.
      await this.assertRenderActive();
      await this.assetRepository.update(asset.id, {
        processingStatus: 'processing',
        processingError: null,
      });
      await pipeline(
        this.storage.readObject(asset.originalStorageKey),
        createWriteStream(tempPath),
      );
      await this.jobRepository.update(this.ownedJob(render), {
        progressPercent: 30,
        progressMessage: 'Extracting media metadata',
      });

      const report: ProgressReporter = async (progressPercent, progressMessage) => {
        // Never overwrite the message of a job cancelled or re-claimed meanwhile.
        await this.jobRepository.update(this.ownedJob(render), {
          progressPercent,
          progressMessage,
        });
      };
      return asset.assetType === 'image'
        ? await this.processImage(asset, tempPath, profile, report, reuse)
        : await this.processVideo(asset, tempPath, profile, report, reuse);
    } finally {
      await this.removeTempFile(tempPath);
    }
  }

  /**
   * Whether this worker run still holds the job it renders; aborts the render once it does
   * not (cancelled because a newer render of the file was requested, re-queued as stale and
   * possibly claimed by another worker, or deleted with its asset). Throws when the job
   * cannot be read.
   */
  private async isJobActive(render: ActiveRender): Promise<boolean> {
    if (render.controller.signal.aborted) {
      return false;
    }
    const job = await this.jobRepository.findOne({
      select: { id: true, status: true, claimToken: true },
      where: { id: render.jobId },
    });
    if (!job || job.status !== 'processing' || job.claimToken !== render.claimToken) {
      render.controller.abort();
      return false;
    }
    return true;
  }

  /** The periodic cancel check: rides out a database blip, the next check runs in 5 s. */
  private async watchJob(render: ActiveRender): Promise<void> {
    try {
      await this.isJobActive(render);
    } catch (error) {
      this.logger.warn(
        `Render job ${render.jobId} cancel check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Called before every write of a render's output, so a job this run no longer holds never
   * overwrites the output of the render that holds it now. Fails closed: when the job cannot
   * be read, the render fails (and is retried) rather than writing unchecked. No-op outside a
   * job (tests call helpers directly).
   */
  private async assertRenderActive(): Promise<void> {
    const render = this.activeRender.getStore();
    if (render && !(await this.isJobActive(render))) {
      throw new RenderJobCancelledError();
    }
  }

  /**
   * Every output a render of this file should end with: the profile's preview variants and the
   * thumbnail, each with the spec it is rendered with. Only size, watermark look and quality go
   * into a spec, none of which depends on orientation, so a plan made from stored metadata
   * matches one made from the probed file.
   */
  private planOutputs(
    assetType: AssetEntity['assetType'],
    sourceWidth: number,
    sourceHeight: number,
    profile: RenderProfileEntity | null,
  ): PlannedOutput[] {
    const isVideo = assetType === 'video';
    const sizes = this.getRenderSizes(profile);
    const quality = this.getImageQuality(profile);
    const watermarkActive = isWatermarkActive(profile);
    const watermarkSpec = watermarkActive ? watermarkFingerprint(profile) : 'none';
    const previews = planPreviewVariants(
      sourceWidth,
      sourceHeight,
      sizes.variants,
      watermarkActive,
      isVideo,
    );
    // Bitrates are shared out against the largest planned preview, rendered now or not, so a
    // preview gets the same bitrate whichever other previews it is rendered with.
    const largestArea = Math.max(...previews.map((preview) => preview.width * preview.height));
    const outputs: PlannedOutput[] = previews.map((preview) => {
      const bitrate = isVideo
        ? this.getVideoBitrate(profile, (preview.width * preview.height) / largestArea)
        : null;
      const encoding = isVideo ? `br=${bitrate ?? 'crf23'}` : `q=${quality.preview}`;
      return {
        kind: 'preview',
        variantCode: preview.variantCode,
        resolution: preview.resolution,
        width: preview.width,
        height: preview.height,
        watermark: preview.watermark,
        bitrate,
        renderSpec: `${assetType}|${preview.resolution}p|wm=${preview.watermark ? watermarkSpec : 'none'}|${encoding}`,
      };
    });
    outputs.push({
      kind: 'thumbnail',
      variantCode: THUMBNAIL_VARIANT_CODE,
      resolution: 0,
      width: sizes.thumbnailWidth,
      height: 0,
      watermark: false,
      bitrate: null,
      renderSpec: `${assetType}|thumbnail|w=${sizes.thumbnailWidth}|q=${quality.thumbnail}`,
    });
    return outputs;
  }

  /**
   * Splits planned outputs into those to render and those kept as they are: with `reuse`, a
   * ready variant rendered with the same spec is kept. Variants from before specs existed are
   * always rendered again.
   */
  private async splitReusable(
    assetId: string,
    outputs: PlannedOutput[],
    reuse: boolean,
  ): Promise<{ toRender: PlannedOutput[]; reused: string[] }> {
    if (!reuse) {
      return { toRender: outputs, reused: [] };
    }
    const existing = await this.variantRepository.find({ where: { assetId, status: 'ready' } });
    const specByCode = new Map(
      existing.map((variant) => [variant.variantCode, variant.renderSpec]),
    );
    const matches = (output: PlannedOutput) =>
      specByCode.get(output.variantCode) === output.renderSpec;
    return {
      toRender: outputs.filter((output) => !matches(output)),
      reused: outputs.filter(matches).map((output) => output.variantCode),
    };
  }

  /**
   * Finishes a reuse job without downloading the original when the stored size of the file shows
   * that every variant the profile asks for already exists with the same spec. Returns null when
   * something has to be rendered (or the size is unknown).
   */
  private async reuseMatchingVariants(
    asset: AssetEntity,
    profile: RenderProfileEntity | null,
  ): Promise<RenderResult | null> {
    const width = readPositiveNumber(asset.sourceMetadata?.width);
    const height = readPositiveNumber(asset.sourceMetadata?.height);
    if (!width || !height) {
      return null;
    }
    const outputs = this.planOutputs(asset.assetType, width, height, profile);
    const { toRender, reused } = await this.splitReusable(asset.id, outputs, true);
    if (toRender.length > 0) {
      return null;
    }
    await this.assertRenderActive();
    const removed = await this.removeStaleVariants(
      asset,
      outputs.map((output) => output.variantCode),
    );
    return { metadata: {}, summary: { rendered: [], reused, removed } };
  }

  private async processImage(
    asset: AssetEntity,
    inputPath: string,
    profile: RenderProfileEntity | null,
    report: ProgressReporter,
    reuse = false,
  ): Promise<RenderResult> {
    const metadata = await sharp(inputPath, { failOn: 'error' }).metadata();
    // EXIF orientations 5-8 swap the displayed width and height.
    const swapped = (metadata.orientation ?? 1) >= 5;
    const sourceWidth = swapped ? metadata.height : metadata.width;
    const sourceHeight = swapped ? metadata.width : metadata.height;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('Image dimensions could not be read');
    }
    const quality = this.getImageQuality(profile);
    const outputs = this.planOutputs('image', sourceWidth, sourceHeight, profile);
    const { toRender, reused } = await this.splitReusable(asset.id, outputs, reuse);

    for (const [index, output] of toRender.entries()) {
      await report(
        this.progressFor(index, toRender.length),
        output.kind === 'thumbnail'
          ? 'Rendering thumbnail'
          : `Rendering ${output.resolution}p image preview`,
      );
      await this.createImageVariant(
        asset,
        inputPath,
        output,
        output.kind === 'thumbnail' ? quality.thumbnail : quality.preview,
        profile,
      );
    }
    await this.assertRenderActive();
    const removed = await this.removeStaleVariants(
      asset,
      outputs.map((output) => output.variantCode),
    );

    return {
      metadata: {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      },
      summary: { rendered: toRender.map((output) => output.variantCode), reused, removed },
    };
  }

  /**
   * Resizes to the planned width (height follows the ratio, never upscaled); previews planned
   * with a watermark get it.
   */
  private async createImageVariant(
    asset: AssetEntity,
    inputPath: string,
    output: PlannedOutput,
    quality: number,
    profile: RenderProfileEntity | null,
  ): Promise<string> {
    const resized = await sharp(inputPath)
      .rotate()
      .resize({ width: output.width, withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    const watermark = output.watermark
      ? await this.createWatermark(resized.info.width, resized.info.height, profile)
      : null;
    const image = sharp(resized.data);
    if (watermark) {
      image.composite([{ input: watermark.buffer, top: watermark.top, left: watermark.left }]);
    }
    // Smart chroma subsampling keeps the colour edges of watermark text and logos crisp; plain
    // 4:2:0 smears them over two pixels, which shows on small previews.
    const rendered = await image
      .webp({ quality, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    const storageKey = `${this.projectPrefix(asset.originalStorageKey, asset.id)}/variants/${asset.id}/${output.variantCode}.webp`;
    await this.assertRenderActive();
    const head = await this.storage.putObject(storageKey, rendered.data, 'image/webp');
    await this.saveVariant(asset, {
      variantCode: output.variantCode,
      storageKey,
      mimeType: 'image/webp',
      sizeBytes: head.sizeBytes,
      width: rendered.info.width,
      height: rendered.info.height,
      hasWatermark: Boolean(watermark),
      renderSpec: output.renderSpec,
      profile,
    });
    return output.variantCode;
  }

  private async processVideo(
    asset: AssetEntity,
    inputPath: string,
    profile: RenderProfileEntity | null,
    report: ProgressReporter,
    reuse = false,
  ): Promise<RenderResult> {
    const probe = await this.runProcess(ffprobePath, [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);
    const parsed = JSON.parse(probe.stdout) as {
      format?: { duration?: string; format_name?: string };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        tags?: { rotate?: string };
        side_data_list?: Array<{ rotation?: number }>;
      }>;
    };
    const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const width = videoStream?.width;
    const height = videoStream?.height;
    const parsedDuration = parsed.format?.duration ? Number(parsed.format.duration) : undefined;
    const durationSeconds =
      parsedDuration !== undefined && Number.isFinite(parsedDuration) ? parsedDuration : undefined;
    const frameRate = videoStream?.r_frame_rate
      ? this.parseFrameRate(videoStream.r_frame_rate)
      : undefined;
    if (!width || !height) {
      throw new Error('Video dimensions could not be read');
    }

    // FFmpeg applies the rotation of phone videos before the filters, so previews are planned on
    // the displayed frame.
    const rotation = Number(
      videoStream?.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ??
        videoStream?.tags?.rotate ??
        0,
    );
    const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    const outputs = this.planOutputs(
      'video',
      quarterTurn ? height : width,
      quarterTurn ? width : height,
      profile,
    );
    const { toRender, reused } = await this.splitReusable(asset.id, outputs, reuse);
    const thumbnail = toRender.find((output) => output.kind === 'thumbnail');
    const previews = toRender.filter((output) => output.kind === 'preview');
    const quality = this.getImageQuality(profile);

    if (thumbnail) {
      await report(this.progressFor(0, 1), 'Rendering video thumbnail');
      await this.createVideoThumbnail(asset, inputPath, thumbnail, quality, profile);
    }

    if (previews.length > 0) {
      // The thumbnail is quick; the previews take the rest of the 30-95% range.
      const message = `Rendering ${previews.map((output) => `${output.resolution}p`).join(', ')} video previews`;
      await report(this.progressFor(VIDEO_THUMBNAIL_SHARE, 1), message);
      const renderProgress = this.throttledProgress(report, message, (fraction) =>
        this.progressFor(VIDEO_THUMBNAIL_SHARE + (1 - VIDEO_THUMBNAIL_SHARE) * fraction, 1),
      );
      try {
        await this.createVideoPreviews(
          asset,
          inputPath,
          previews,
          profile,
          durationSeconds,
          renderProgress.update,
        );
      } finally {
        await renderProgress.settled();
      }
    }
    await this.assertRenderActive();
    const removed = await this.removeStaleVariants(
      asset,
      outputs.map((output) => output.variantCode),
    );

    return {
      metadata: {
        width,
        height,
        durationSeconds,
        format: parsed.format?.format_name,
        codec: videoStream?.codec_name,
        frameRate,
      },
      summary: { rendered: toRender.map((output) => output.variantCode), reused, removed },
    };
  }

  /** First frame of the video, resized to the thumbnail width, without watermark. */
  private async createVideoThumbnail(
    asset: AssetEntity,
    inputPath: string,
    output: PlannedOutput,
    quality: { thumbnail: number },
    profile: RenderProfileEntity | null,
  ): Promise<string> {
    const posterPath = join(tmpdir(), `${TEMP_FILE_PREFIX}poster-${asset.id}-${Date.now()}.jpg`);
    try {
      await this.runProcess(ffmpegPath, [
        '-y',
        ...this.ffmpegThreadArgs(),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${output.width},iw)':-2`,
        posterPath,
      ]);
      const poster = await sharp(await fs.readFile(posterPath))
        .jpeg({ quality: quality.thumbnail })
        .toBuffer({ resolveWithObject: true });
      const posterKey = `${this.projectPrefix(asset.originalStorageKey, asset.id)}/variants/${asset.id}/${THUMBNAIL_VARIANT_CODE}.jpg`;
      await this.assertRenderActive();
      const posterHead = await this.storage.putObject(posterKey, poster.data, 'image/jpeg');
      await this.saveVariant(asset, {
        variantCode: THUMBNAIL_VARIANT_CODE,
        storageKey: posterKey,
        mimeType: 'image/jpeg',
        sizeBytes: posterHead.sizeBytes,
        width: poster.info.width,
        height: poster.info.height,
        hasWatermark: false,
        renderSpec: output.renderSpec,
        profile,
      });
      return THUMBNAIL_VARIANT_CODE;
    } finally {
      await this.removeTempFile(posterPath);
    }
  }

  /**
   * H.264 previews for every planned output (even dimensions), watermarked when planned so. A
   * single FFmpeg run decodes the source once and encodes every size from it: decoding 4K HEVC
   * is most of the work, and one run per size took about twice as long.
   */
  private async createVideoPreviews(
    asset: AssetEntity,
    inputPath: string,
    planned: PlannedOutput[],
    profile: RenderProfileEntity | null,
    durationSeconds: number | undefined,
    onFraction: (fraction: number) => void,
  ): Promise<string[]> {
    const prefix = this.projectPrefix(asset.originalStorageKey, asset.id);
    const stamp = `${asset.id}-${Date.now()}`;
    const area = (size: { width: number; height: number }) => size.width * size.height;
    const largestArea = Math.max(...planned.map(area));
    const outputs = planned.map((output) => ({
      ...output,
      previewPath: join(tmpdir(), `${TEMP_FILE_PREFIX}preview-${stamp}-${output.variantCode}.mp4`),
      watermarkPath: join(
        tmpdir(),
        `${TEMP_FILE_PREFIX}watermark-${stamp}-${output.variantCode}.png`,
      ),
    }));
    try {
      const watermarks: Array<Awaited<ReturnType<typeof this.createWatermark>>> = [];
      for (const output of outputs) {
        const watermark = output.watermark
          ? await this.createWatermark(output.width, output.height, profile)
          : null;
        if (watermark) {
          await fs.writeFile(output.watermarkPath, watermark.buffer);
        }
        watermarks.push(watermark);
      }

      // Scale the 4K source once to the largest size; smaller sizes are scaled from that.
      const largest = outputs.find((output) => area(output) === largestArea)!;
      const filters = [
        `[0:v]scale=${largest.width}:${largest.height},split=${outputs.length}${outputs
          .map((_, index) => `[s${index}]`)
          .join('')}`,
      ];
      const watermarkArgs: string[] = [];
      for (const [index, output] of outputs.entries()) {
        let label = `[s${index}]`;
        if (area(output) !== largestArea) {
          filters.push(`${label}scale=${output.width}:${output.height}[r${index}]`);
          label = `[r${index}]`;
        }
        const watermark = watermarks[index];
        if (watermark) {
          watermarkArgs.push('-i', output.watermarkPath);
          // Input 0 is the source; watermark inputs follow in order.
          const input = watermarkArgs.length / 2;
          filters.push(
            `${label}[${input}:v]overlay=${watermark.left}:${watermark.top}:format=auto,format=yuv420p[v${index}]`,
          );
        } else {
          filters.push(`${label}format=yuv420p[v${index}]`);
        }
      }

      const threads = String(this.config.getOrThrow<number>('MEDIA_FFMPEG_THREADS'));
      const args = [
        '-y',
        ...FFMPEG_PROGRESS_ARGS,
        ...this.ffmpegThreadArgs(),
        '-i',
        inputPath,
        ...watermarkArgs,
        '-filter_complex',
        filters.join(';'),
        ...outputs.flatMap((output, index) => [
          '-map',
          `[v${index}]`,
          '-map',
          '0:a?',
          '-c:v',
          'libx264',
          '-threads',
          threads,
          '-preset',
          'veryfast',
          ...(output.bitrate
            ? [
                '-b:v',
                String(output.bitrate),
                '-maxrate',
                String(Math.round(output.bitrate * 1.5)),
                '-bufsize',
                String(output.bitrate * 2),
              ]
            : ['-crf', '23']),
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-sn',
          '-dn',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          output.previewPath,
        ]),
      ];
      await this.runProcess(ffmpegPath, args, {
        // A long source renders for minutes while advancing steadily; only a stuck FFmpeg
        // should be killed early.
        timeoutMs: this.renderTimeoutMs(durationSeconds),
        stallMs: RENDER_STALL_MS,
        onProgress: (outputSeconds) => {
          if (durationSeconds) {
            onFraction(Math.min(1, outputSeconds / durationSeconds));
          }
        },
      });

      const codes: string[] = [];
      for (const [index, output] of outputs.entries()) {
        const previewKey = `${prefix}/variants/${asset.id}/${output.variantCode}.mp4`;
        await this.assertRenderActive();
        // Streamed so a long preview never sits in the Node heap as one Buffer.
        const { size: previewSize } = await fs.stat(output.previewPath);
        const previewHead = await this.storage.putObject(
          previewKey,
          createReadStream(output.previewPath),
          'video/mp4',
          previewSize,
        );
        await this.saveVariant(asset, {
          variantCode: output.variantCode,
          storageKey: previewKey,
          mimeType: 'video/mp4',
          sizeBytes: previewHead.sizeBytes,
          width: output.width,
          height: output.height,
          hasWatermark: Boolean(watermarks[index]),
          renderSpec: output.renderSpec,
          profile,
        });
        codes.push(output.variantCode);
      }
      return codes;
    } finally {
      for (const output of outputs) {
        await this.removeTempFile(output.previewPath);
        await this.removeTempFile(output.watermarkPath);
      }
    }
  }

  /**
   * Best-effort temp file cleanup. A file still locked by a just-exited FFmpeg (EBUSY on
   * Windows) must not fail a render that already finished; removeLeftoverTempFiles catches it
   * on the next start.
   */
  private async removeTempFile(path: string): Promise<void> {
    try {
      await fs.rm(path, { force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      this.logger.warn(
        `Temp file ${path} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Deletes variants the profile no longer asks for (a variant removed from the profile, or a
   * legacy width-based preview), including their stored objects. Returns their codes.
   */
  private async removeStaleVariants(asset: AssetEntity, keepCodes: string[]): Promise<string[]> {
    const stale = await this.variantRepository.find({
      where: { assetId: asset.id, variantCode: Not(In(keepCodes)) },
    });
    for (const variant of stale) {
      try {
        await this.storage.deleteObject(variant.storageKey);
      } catch (error) {
        this.logger.warn(
          `Stale variant ${variant.storageKey} could not be deleted: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.variantRepository.delete(variant.id);
    }
    return stale.map((variant) => variant.variantCode);
  }

  private async saveVariant(
    asset: AssetEntity,
    variant: {
      variantCode: string;
      storageKey: string;
      mimeType: string;
      sizeBytes: number;
      width?: number;
      height?: number;
      hasWatermark: boolean;
      renderSpec: string;
      profile?: RenderProfileEntity | null;
    },
  ): Promise<void> {
    // An upload is not stopped by an abort; re-check after it before pointing the row at it.
    await this.assertRenderActive();
    const existing = await this.variantRepository.findOne({
      where: { assetId: asset.id, variantCode: variant.variantCode },
    });
    await this.variantRepository.save(
      this.variantRepository.create({
        id: existing?.id ?? uuidv7(),
        assetId: asset.id,
        variantCode: variant.variantCode,
        storageProvider: asset.storageProvider,
        bucketName: asset.originalBucket,
        storageKey: variant.storageKey,
        mimeType: variant.mimeType,
        fileSizeBytes: String(variant.sizeBytes),
        renderProfileId: variant.profile?.id ?? null,
        renderVersion: variant.profile?.profileVersion ?? 1,
        width: variant.width ?? null,
        height: variant.height ?? null,
        hasWatermark: variant.hasWatermark,
        renderSpec: variant.renderSpec,
        status: 'ready',
        processingError: null,
      }),
    );
  }

  private projectPrefix(originalStorageKey: string, assetId: string): string {
    const match = /^projects\/([^/]+)\//.exec(originalStorageKey);
    return match ? `projects/${match[1]}` : `assets/${assetId}`;
  }

  private parseFrameRate(value: string): number | undefined {
    const [numerator, denominator] = value.split('/').map(Number);
    if (!numerator || !denominator) {
      return undefined;
    }
    return numerator / denominator;
  }

  private getImageQuality(profile: RenderProfileEntity | null) {
    const preview = Math.min(100, Math.max(1, Math.round(profile?.imageQuality ?? 85)));
    return { preview, thumbnail: Math.min(preview, 80) };
  }

  private getRenderSizes(profile: RenderProfileEntity | null): RenderSizes {
    return normalizeRenderSizes(profile, {
      previewWidth: this.config.getOrThrow<number>('MEDIA_PREVIEW_MAX_WIDTH'),
      thumbnailWidth: this.config.getOrThrow<number>('MEDIA_THUMBNAIL_MAX_WIDTH'),
    });
  }

  /**
   * `videoBitrateBps` is the bitrate of the largest preview; smaller ones get a share
   * proportional to their pixel area. Without it, x264 uses constant quality (CRF).
   */
  private getVideoBitrate(profile: RenderProfileEntity | null, areaRatio: number): number | null {
    const bitrate = Number(profile?.videoBitrateBps ?? 0);
    if (!Number.isFinite(bitrate) || bitrate <= 0) {
      return null;
    }
    return Math.max(300_000, Math.round(bitrate * areaRatio));
  }

  /** Job progress between 30% (original downloaded) and 95% while variants are rendered. */
  private progressFor(step: number, totalSteps: number): number {
    return 30 + Math.round((65 * step) / Math.max(1, totalSteps));
  }

  /**
   * Builds the watermark overlay for a frame of `baseWidth` x `baseHeight`. Sizes follow
   * watermark-layout.ts so the settings preview matches what the renderer produces.
   */
  private async createWatermark(
    baseWidth: number,
    baseHeight: number,
    profile: RenderProfileEntity | null,
  ): Promise<{ buffer: Buffer; width: number; height: number; top: number; left: number } | null> {
    if (!profile || !isWatermarkActive(profile)) {
      return null;
    }
    const config = normalizeWatermarkConfig(profile.watermarkConfig);
    const text = config.text.trim().slice(0, 120);
    const logo = await this.loadWatermarkLogo(config.logoAssetId);
    if (!text && !logo) {
      throw new Error('Watermark logo could not be loaded and no watermark text is configured');
    }

    const unitScale = getWatermarkUnitScale(baseWidth);
    const margin = getWatermarkMargin(config.margin, baseWidth, baseHeight);
    // Measured at 4x so rounding of the rasterised width does not skew the final size. The
    // reference uses the default logo size so `logoScale` resizes the logo, not the text.
    const tileScale = config.repeat
      ? unitScale
      : getSingleWatermarkTileScale(
          (await this.renderWatermarkTile({ ...config, logoScale: 1 }, text, logo, 4, false))
            .width / 4,
          baseWidth,
          config.scale,
        );
    const tile = await this.renderWatermarkTile(config, text, logo, tileScale, true);

    if (config.repeat) {
      const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
      const padded = await sharp(tile.buffer)
        .extend({
          right: Math.round(config.gapX * unitScale),
          bottom: Math.round(config.gapY * unitScale),
          background: transparent,
        })
        .png()
        .toBuffer({ resolveWithObject: true });
      // sharp refuses to composite an overlay larger than the base, so crop oversized tiles.
      const pattern =
        padded.info.width > baseWidth || padded.info.height > baseHeight
          ? await sharp(padded.data)
              .extract({
                left: 0,
                top: 0,
                width: Math.min(baseWidth, padded.info.width),
                height: Math.min(baseHeight, padded.info.height),
              })
              .png()
              .toBuffer()
          : padded.data;
      const buffer = await sharp({
        create: { width: baseWidth, height: baseHeight, channels: 4, background: transparent },
      })
        .composite([{ input: pattern, tile: true, gravity: 'northwest' }])
        .png()
        .toBuffer();
      return { buffer, width: baseWidth, height: baseHeight, top: 0, left: 0 };
    }

    // Large (or rotated) watermarks may hang off the frame; only the visible part is kept, since
    // neither sharp nor ffmpeg accept overlays outside the base.
    const position = getOverlayPosition(
      baseWidth,
      baseHeight,
      tile.width,
      tile.height,
      config.position,
      margin,
    );
    const clip = clipToFrame(
      baseWidth,
      baseHeight,
      tile.width,
      tile.height,
      position.top,
      position.left,
    );
    if (!clip) {
      throw new Error('Watermark falls outside the frame, reduce the watermark margin');
    }
    const visible =
      clip.extract.width === tile.width && clip.extract.height === tile.height
        ? tile.buffer
        : await sharp(tile.buffer).extract(clip.extract).png().toBuffer();
    return {
      buffer: visible,
      width: clip.extract.width,
      height: clip.extract.height,
      top: clip.top,
      left: clip.left,
    };
  }

  /**
   * Renders the logo + text tile at `config.fontSize * scale`, cropped to the drawn width.
   * When `finalize` is set the tile is also rotated and faded to the configured opacity.
   *
   * Kept sharp at small sizes: the logo is downscaled up front (Lanczos) to its exact pixel size
   * and drawn 1:1 on whole pixels, and rotation happens in the SVG so text is rasterised once,
   * already rotated, instead of being resampled afterwards.
   */
  private async renderWatermarkTile(
    config: WatermarkConfig,
    text: string,
    logo: { buffer: Buffer; mimeType: string } | null,
    scale: number,
    finalize: boolean,
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const fontSize = Math.max(1, config.fontSize * scale);
    const geometry = getWatermarkTileGeometry(fontSize, Boolean(logo), config.logoScale);
    const canvasWidth = Math.max(1, Math.ceil(geometry.textX + (text.length + 2) * fontSize * 1.2));
    const canvasHeight = Math.max(1, geometry.height);
    const logoSvg = logo ? await this.renderLogoImage(logo, geometry.logoSize, geometry.logoY) : '';
    const textSvg = text
      ? `<text x="${geometry.textX}" y="${geometry.textBaselineY}" fill="${this.escapeXml(
          config.color,
        )}" font-family="${this.escapeXml(config.fontFamily)}" font-size="${fontSize}" font-weight="${config.fontWeight}">${this.escapeXml(text)}</text>`
      : '';
    const content = `${logoSvg}${textSvg}`;
    const drawn = await sharp(Buffer.from(this.svgDocument(canvasWidth, canvasHeight, content)))
      .png()
      .toBuffer();
    const stats = await sharp(drawn).stats();
    if ((stats.channels[3]?.max ?? 0) === 0) {
      throw new Error('Watermark rendered empty, check that the watermark font is installed');
    }
    // Crop the right-hand slack: the canvas is sized from an estimate of the text width.
    const trimmed = await sharp(drawn)
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer({ resolveWithObject: true });
    const drawnWidth = Math.min(
      canvasWidth,
      Math.max(1, -(trimmed.info.trimOffsetLeft ?? 0) + trimmed.info.width),
    );
    const cropped = await sharp(drawn)
      .extract({ left: 0, top: 0, width: drawnWidth, height: canvasHeight })
      .png()
      .toBuffer();
    if (!finalize) {
      return { buffer: cropped, width: drawnWidth, height: canvasHeight };
    }

    let rotated = cropped;
    if (config.rotate % 360 !== 0) {
      const size = getRotatedSize(drawnWidth, canvasHeight, config.rotate);
      rotated = await sharp(
        Buffer.from(
          this.svgDocument(
            size.width,
            size.height,
            `<clipPath id="tile"><rect width="${drawnWidth}" height="${canvasHeight}"/></clipPath>` +
              `<g transform="translate(${size.width / 2} ${size.height / 2}) rotate(${config.rotate}) translate(${-drawnWidth / 2} ${-canvasHeight / 2})">` +
              `<g clip-path="url(#tile)">${content}</g></g>`,
          ),
        ),
      )
        .png()
        .toBuffer();
    }
    // Fade logo and text together, matching globalAlpha in the settings preview.
    const faded = await sharp(rotated)
      .ensureAlpha()
      .composite([
        {
          input: Buffer.from([0, 0, 0, Math.round(config.opacity * 255)]),
          raw: { width: 1, height: 1, channels: 4 },
          tile: true,
          blend: 'dest-in',
        },
      ])
      .png()
      .toBuffer({ resolveWithObject: true });
    return { buffer: faded.data, width: faded.info.width, height: faded.info.height };
  }

  private svgDocument(width: number, height: number, content: string): string {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${content}</svg>`;
  }

  /**
   * `<image>` of the logo fitted inside the `size` square at `top` (centred, aspect kept). The
   * bitmap is resized here to its final pixel size, so librsvg only copies it: letting librsvg
   * shrink a large logo to a few dozen pixels gives a soft, aliased result.
   */
  private async renderLogoImage(
    logo: { buffer: Buffer; mimeType: string },
    size: number,
    top: number,
  ): Promise<string> {
    const resized = await sharp(logo.buffer)
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', kernel: 'lanczos3' })
      .png()
      .toBuffer({ resolveWithObject: true });
    const x = Math.floor((size - resized.info.width) / 2);
    const y = top + Math.floor((size - resized.info.height) / 2);
    return `<image href="data:image/png;base64,${resized.data.toString('base64')}" x="${x}" y="${y}" width="${resized.info.width}" height="${resized.info.height}"/>`;
  }

  private async loadWatermarkLogo(
    logoAssetId: string | null,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    if (!logoAssetId) {
      return null;
    }
    const logo = await this.assetRepository.findOne({ where: { id: logoAssetId } });
    if (!logo) {
      this.logger.warn(`Watermark logo asset ${logoAssetId} was not found`);
      return null;
    }
    try {
      return await this.readLogoData(logo.originalStorageKey, logo.mimeType);
    } catch (error) {
      this.logger.warn(
        `Watermark logo ${logoAssetId} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async readLogoData(storageKey: string, mimeType: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of this.storage.readObject(storageKey)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), mimeType };
  }

  private escapeXml(value: string): string {
    return value.replace(/[<>&'"]/g, (character) => {
      const entities: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      };
      return entities[character] ?? character;
    });
  }

  /**
   * Input-side thread caps. FFmpeg sizes its thread pools from the host's cores, not the
   * container's CPU limit, and each decoder thread holds its own frames, which for 4K
   * sources is what pushes the worker past its memory limit.
   */
  private ffmpegThreadArgs(): string[] {
    const threads = String(this.config.getOrThrow<number>('MEDIA_FFMPEG_THREADS'));
    return ['-threads', threads, '-filter_threads', threads, '-filter_complex_threads', threads];
  }

  /**
   * Total budget for one preview render. Scales with the source length, since a long 4K
   * source renders for minutes while making steady progress; hangs are caught by the stall
   * check instead.
   */
  private renderTimeoutMs(durationSeconds: number | undefined): number {
    const minimumSeconds = this.config.getOrThrow<number>('MEDIA_RENDER_TIMEOUT_SECONDS');
    return (
      Math.max(minimumSeconds, (durationSeconds ?? 0) * RENDER_SECONDS_PER_SOURCE_SECOND) * 1000
    );
  }

  /**
   * Turns FFmpeg's frequent position reports into at most one job update per
   * PROGRESS_REPORT_INTERVAL_MS. `settled` waits for the queued updates, so a late one cannot
   * overwrite the next step's (or the final) progress.
   */
  private throttledProgress(
    report: ProgressReporter,
    message: string,
    toPercent: (fraction: number) => number,
  ): { update: (fraction: number) => void; settled: () => Promise<void> } {
    let lastAt = 0;
    let lastPercent = -1;
    let pending: Promise<void> = Promise.resolve();
    return {
      update: (fraction) => {
        const percent = toPercent(fraction);
        const now = Date.now();
        if (percent === lastPercent || now - lastAt < PROGRESS_REPORT_INTERVAL_MS) {
          return;
        }
        lastAt = now;
        lastPercent = percent;
        pending = pending
          .then(() => report(percent, message))
          .catch((error: unknown) => {
            this.logger.warn(
              `Progress update failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      },
      settled: () => pending,
    };
  }

  private runProcess(
    command: string | null,
    args: string[],
    options: RunProcessOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    if (!command) {
      return Promise.reject(new Error('FFmpeg binary is not available'));
    }
    const timeoutMs =
      options.timeoutMs ?? this.config.getOrThrow<number>('MEDIA_RENDER_TIMEOUT_SECONDS') * 1000;
    const { stallMs, onProgress } = options;
    const signal = this.activeRender.getStore()?.controller.signal;
    if (signal?.aborted) {
      return Promise.reject(new RenderJobCancelledError());
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      // Why this method killed the command; reported instead of the bare signal.
      let failure: string | undefined;
      const kill = (reason: string) => {
        failure ??= reason;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => kill('Media processing timed out'), timeoutMs);
      let lastAdvanceAt = Date.now();
      const stallTimer = stallMs
        ? setInterval(
            () => {
              if (Date.now() - lastAdvanceAt > stallMs) {
                kill(`Media processing stalled: no progress for ${Math.round(stallMs / 1000)}s`);
              }
            },
            Math.min(STALL_CHECK_MS, stallMs),
          )
        : undefined;
      const onAbort = () => kill('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      const stopTimers = () => {
        clearTimeout(timer);
        clearInterval(stallTimer);
        signal?.removeEventListener('abort', onAbort);
      };

      // With FFMPEG_PROGRESS_ARGS, stdout is a stream of `key=value` lines; each block ends
      // with `progress=continue|end`.
      let partialLine = '';
      let frame = '';
      let outTimeUs = '';
      let position = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (!stallMs) {
          stdout += chunk.toString();
          return;
        }
        const lines = (partialLine + chunk.toString()).split('\n');
        partialLine = lines.pop() ?? '';
        for (const line of lines) {
          const separator = line.indexOf('=');
          const key = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim();
          if (key === 'frame') {
            frame = value;
          } else if (key === 'out_time_us') {
            outTimeUs = value;
          } else if (key === 'progress' && `${frame}|${outTimeUs}` !== position) {
            position = `${frame}|${outTimeUs}`;
            lastAdvanceAt = Date.now();
            const micros = Number(outTimeUs);
            if (Number.isFinite(micros) && micros >= 0) {
              onProgress?.(micros / 1_000_000);
            }
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Only the tail is ever reported.
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      });
      child.once('error', (error) => {
        stopTimers();
        reject(error);
      });
      child.once('close', (code, exitSignal) => {
        stopTimers();
        if (failure === 'cancelled') {
          reject(new RenderJobCancelledError());
          return;
        }
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        // FFmpeg prints its banner first and the actual error last; keep the end.
        const detail = stderr.trim().slice(-STDERR_TAIL_CHARS);
        // A killed FFmpeg never prints an error, so its stderr alone looks like a normal run.
        const reason =
          failure ??
          (exitSignal === 'SIGKILL'
            ? 'Media command was killed (SIGKILL), most likely out of memory'
            : exitSignal
              ? `Media command was killed (${exitSignal})`
              : undefined);
        if (reason) {
          reject(new Error(detail ? `${reason}\n${detail}` : reason));
          return;
        }
        reject(new Error(detail || `Media command exited with code ${code ?? 'unknown'}`));
      });
    });
  }
}
