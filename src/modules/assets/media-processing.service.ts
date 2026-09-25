import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import ffmpegPath from 'ffmpeg-static';
import { path as ffprobePath } from 'ffprobe-static';
import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { In, Not, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import {
  normalizeRenderSizes,
  previewVariantCode,
  selectPreviewWidths,
  type RenderSizes,
} from '../render/render-sizes';
import { normalizeWatermarkConfig, type WatermarkConfig } from '../render/watermark-config';
import {
  fitWithin,
  getOverlayPosition,
  getSingleWatermarkTileScale,
  getVideoRenderSize,
  getWatermarkTileGeometry,
  getWatermarkUnitScale,
} from '../render/watermark-layout';
import {
  findActiveRenderProfile,
  isWatermarkActive,
  THUMBNAIL_VARIANT_CODE,
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

@Injectable()
export class MediaProcessingService {
  private readonly logger = new Logger(MediaProcessingService.name);

  constructor(
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepository: Repository<AssetVariantEntity>,
    @InjectRepository(MediaRenderJobEntity)
    private readonly jobRepository: Repository<MediaRenderJobEntity>,
    @InjectRepository(RenderProfileEntity)
    private readonly renderProfileRepository: Repository<RenderProfileEntity>,
    @InjectRepository(RenderBatchEntity)
    private readonly renderBatchRepository: Repository<RenderBatchEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly config: ConfigService,
  ) {}

  async processJobById(jobId: string, assetId: string, queueJobId?: string): Promise<void> {
    const job = await this.jobRepository.findOne({ where: { id: jobId, assetId } });
    if (!job) {
      throw new Error(`Render job ${jobId} was not found`);
    }

    const claimed = await this.jobRepository
      .createQueryBuilder()
      .update(MediaRenderJobEntity)
      .set({
        status: 'processing',
        progressPercent: 5,
        progressMessage: 'Reading original object',
        startedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        attemptCount: () => 'attempt_count + 1',
      })
      .where('id = :id AND status IN (:...statuses)', {
        id: job.id,
        statuses: ['queued', 'failed'],
      })
      .execute();
    if (!claimed.affected) {
      return;
    }
    if (queueJobId) {
      await this.jobRepository.update(job.id, { queueJobId });
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

      const tempPath = join(tmpdir(), `ag-go-${asset.id}-${Date.now()}`);
      try {
        await this.assetRepository.update(asset.id, {
          processingStatus: 'processing',
          processingError: null,
        });
        await pipeline(
          this.storage.readObject(asset.originalStorageKey),
          createWriteStream(tempPath),
        );
        await this.jobRepository.update(job.id, {
          progressPercent: 30,
          progressMessage: 'Extracting media metadata',
        });

        const report: ProgressReporter = async (progressPercent, progressMessage) => {
          await this.jobRepository.update(job.id, { progressPercent, progressMessage });
        };
        const metadata =
          asset.assetType === 'image'
            ? await this.processImage(asset, tempPath, profile, report)
            : await this.processVideo(asset, tempPath, profile, report);

        await this.assetRepository.update(asset.id, {
          processingStatus: 'ready',
          processingError: null,
          sourceMetadata: {
            ...(asset.sourceMetadata ?? {}),
            ...metadata,
          },
        });
        await this.jobRepository.update(job.id, {
          status: 'completed',
          progressPercent: 100,
          progressMessage: 'Media variants are ready',
          finishedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        });
        await this.refreshRenderBatch(job.renderBatchId);
      } finally {
        await fs.rm(tempPath, { force: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Media processing failed';
      this.logger.error(`Asset ${assetId} processing failed: ${message}`);
      await this.assetRepository.update(assetId, {
        processingStatus: 'failed',
        processingError: message.slice(0, 4000),
      });
      await this.jobRepository.update(job.id, {
        status: 'failed',
        progressMessage: 'Media processing failed',
        errorCode: 'PROCESSING_FAILED',
        errorMessage: message.slice(0, 4000),
        finishedAt: new Date(),
      });
      await this.refreshRenderBatch(job.renderBatchId);
      throw error;
    }
  }

  private async refreshRenderBatch(batchId: string | null): Promise<void> {
    if (!batchId) {
      return;
    }
    const jobs = await this.jobRepository.find({ where: { renderBatchId: batchId } });
    if (jobs.length === 0) {
      return;
    }
    const completed = jobs.filter((item) => item.status === 'completed').length;
    const failed = jobs.filter((item) => item.status === 'failed').length;
    const cancelled = jobs.filter((item) => item.status === 'cancelled').length;
    const terminal = completed + failed + cancelled;
    const status =
      terminal < jobs.length
        ? 'processing'
        : failed > 0 || cancelled > 0
          ? completed > 0
            ? 'partial'
            : 'failed'
          : 'completed';
    await this.renderBatchRepository.update(batchId, {
      status,
      totalJobs: jobs.length,
      completedJobs: completed,
      failedJobs: failed,
      progressPercent: Math.round((terminal / jobs.length) * 100),
    });
  }

  private async processImage(
    asset: AssetEntity,
    inputPath: string,
    profile: RenderProfileEntity | null,
    report: ProgressReporter,
  ): Promise<MediaMetadata> {
    const metadata = await sharp(inputPath, { failOn: 'error' }).metadata();
    const sizes = this.getRenderSizes(profile);
    const quality = this.getImageQuality(profile);
    // EXIF orientations 5-8 swap the displayed width and height.
    const sourceWidth =
      (metadata.orientation ?? 1) >= 5 ? (metadata.height ?? 0) : (metadata.width ?? 0);
    const widths = selectPreviewWidths(sourceWidth, sizes.previewWidths);

    const codes: string[] = [];
    for (const [index, width] of widths.entries()) {
      await report(
        this.progressFor(index, widths.length + 1),
        `Rendering ${width}px image preview`,
      );
      codes.push(
        await this.createImageVariant(asset, inputPath, 'preview', width, quality.preview, profile),
      );
    }
    await report(this.progressFor(widths.length, widths.length + 1), 'Rendering thumbnail');
    codes.push(
      await this.createImageVariant(
        asset,
        inputPath,
        THUMBNAIL_VARIANT_CODE,
        sizes.thumbnailWidth,
        quality.thumbnail,
        profile,
      ),
    );
    await this.removeStaleVariants(asset, codes);

    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  }

  /** Resizes to `width` (height follows the ratio, never upscaled); previews get the watermark. */
  private async createImageVariant(
    asset: AssetEntity,
    inputPath: string,
    kind: 'preview' | typeof THUMBNAIL_VARIANT_CODE,
    width: number,
    quality: number,
    profile: RenderProfileEntity | null,
  ): Promise<string> {
    const resized = await sharp(inputPath)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .png()
      .toBuffer({ resolveWithObject: true });
    const watermark =
      kind === 'preview'
        ? await this.createWatermark(resized.info.width, resized.info.height, profile)
        : null;
    const image = sharp(resized.data);
    if (watermark) {
      image.composite([{ input: watermark.buffer, top: watermark.top, left: watermark.left }]);
    }
    const output = await image.webp({ quality }).toBuffer({ resolveWithObject: true });
    const variantCode =
      kind === 'preview' ? previewVariantCode(output.info.width) : THUMBNAIL_VARIANT_CODE;
    const storageKey = `${this.projectPrefix(asset.originalStorageKey, asset.id)}/variants/${asset.id}/${variantCode}.webp`;
    const head = await this.storage.putObject(storageKey, output.data, 'image/webp');
    await this.saveVariant(
      asset,
      variantCode,
      storageKey,
      'image/webp',
      head.sizeBytes,
      output.info.width,
      output.info.height,
      Boolean(watermark),
      profile,
    );
    return variantCode;
  }

  private async processVideo(
    asset: AssetEntity,
    inputPath: string,
    profile: RenderProfileEntity | null,
    report: ProgressReporter,
  ): Promise<MediaMetadata> {
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

    const sizes = this.getRenderSizes(profile);
    const quality = this.getImageQuality(profile);
    const renderSizes = this.uniqueSizes(
      selectPreviewWidths(width, sizes.previewWidths).map((previewWidth) =>
        getVideoRenderSize(width, height, { maxWidth: previewWidth })!,
      ),
    );
    const steps = renderSizes.length + 1;
    const codes: string[] = [];

    await report(this.progressFor(0, steps), 'Rendering video thumbnail');
    codes.push(
      await this.createVideoThumbnail(asset, inputPath, sizes.thumbnailWidth, quality, profile),
    );

    const largestArea = Math.max(...renderSizes.map((size) => size.width * size.height));
    for (const [index, size] of renderSizes.entries()) {
      await report(this.progressFor(index + 1, steps), `Rendering ${size.width}px video preview`);
      codes.push(
        await this.createVideoPreview(
          asset,
          inputPath,
          size,
          this.getVideoBitrate(profile, (size.width * size.height) / largestArea),
          profile,
        ),
      );
    }
    await this.removeStaleVariants(asset, codes);

    return {
      width,
      height,
      durationSeconds,
      format: parsed.format?.format_name,
      codec: videoStream?.codec_name,
      frameRate,
    };
  }

  /** First frame of the video, resized to the thumbnail width, without watermark. */
  private async createVideoThumbnail(
    asset: AssetEntity,
    inputPath: string,
    thumbnailWidth: number,
    quality: { thumbnail: number },
    profile: RenderProfileEntity | null,
  ): Promise<string> {
    const posterPath = join(tmpdir(), `ag-go-poster-${asset.id}-${Date.now()}.jpg`);
    try {
      await this.runProcess(ffmpegPath, [
        '-y',
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${thumbnailWidth},iw)':-2`,
        posterPath,
      ]);
      const poster = await sharp(await fs.readFile(posterPath))
        .jpeg({ quality: quality.thumbnail })
        .toBuffer({ resolveWithObject: true });
      const posterKey = `${this.projectPrefix(asset.originalStorageKey, asset.id)}/variants/${asset.id}/${THUMBNAIL_VARIANT_CODE}.jpg`;
      const posterHead = await this.storage.putObject(posterKey, poster.data, 'image/jpeg');
      await this.saveVariant(
        asset,
        THUMBNAIL_VARIANT_CODE,
        posterKey,
        'image/jpeg',
        posterHead.sizeBytes,
        poster.info.width,
        poster.info.height,
        false,
        profile,
      );
      return THUMBNAIL_VARIANT_CODE;
    } finally {
      await fs.rm(posterPath, { force: true });
    }
  }

  /** H.264 preview at `size` (even dimensions), watermarked when the profile has one. */
  private async createVideoPreview(
    asset: AssetEntity,
    inputPath: string,
    size: { width: number; height: number },
    bitrate: number | null,
    profile: RenderProfileEntity | null,
  ): Promise<string> {
    const variantCode = previewVariantCode(size.width);
    const previewKey = `${this.projectPrefix(asset.originalStorageKey, asset.id)}/variants/${asset.id}/${variantCode}.mp4`;
    const stamp = `${asset.id}-${size.width}-${Date.now()}`;
    const previewPath = join(tmpdir(), `ag-go-preview-${stamp}.mp4`);
    const watermarkPath = join(tmpdir(), `ag-go-watermark-${stamp}.png`);
    try {
      const watermark = await this.createWatermark(size.width, size.height, profile);
      if (watermark) {
        await fs.writeFile(watermarkPath, watermark.buffer);
      }
      const scale = `[0:v]scale=${size.width}:${size.height}`;
      await this.runProcess(ffmpegPath, [
        '-y',
        '-i',
        inputPath,
        ...(watermark ? ['-i', watermarkPath] : []),
        '-filter_complex',
        watermark
          ? `${scale}[base];[base][1:v]overlay=${watermark.left}:${watermark.top}:format=auto,format=yuv420p[v]`
          : `${scale},format=yuv420p[v]`,
        '-map',
        '[v]',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        ...(bitrate
          ? [
              '-b:v',
              String(bitrate),
              '-maxrate',
              String(Math.round(bitrate * 1.5)),
              '-bufsize',
              String(bitrate * 2),
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
        previewPath,
      ]);
      const preview = await fs.readFile(previewPath);
      const previewHead = await this.storage.putObject(previewKey, preview, 'video/mp4');
      await this.saveVariant(
        asset,
        variantCode,
        previewKey,
        'video/mp4',
        previewHead.sizeBytes,
        size.width,
        size.height,
        Boolean(watermark),
        profile,
      );
      return variantCode;
    } finally {
      await fs.rm(previewPath, { force: true });
      await fs.rm(watermarkPath, { force: true });
    }
  }

  /**
   * Deletes variants that the latest render did not produce (a preview width removed from the
   * profile, or the legacy single `preview`), including their stored objects.
   */
  private async removeStaleVariants(asset: AssetEntity, keepCodes: string[]): Promise<void> {
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
  }

  private async saveVariant(
    asset: AssetEntity,
    variantCode: string,
    storageKey: string,
    mimeType: string,
    sizeBytes: number,
    width?: number,
    height?: number,
    hasWatermark = true,
    profile?: RenderProfileEntity | null,
  ): Promise<void> {
    const existing = await this.variantRepository.findOne({
      where: { assetId: asset.id, variantCode },
    });
    await this.variantRepository.save(
      this.variantRepository.create({
        id: existing?.id ?? uuidv7(),
        assetId: asset.id,
        variantCode,
        storageProvider: asset.storageProvider,
        bucketName: asset.originalBucket,
        storageKey,
        mimeType,
        fileSizeBytes: String(sizeBytes),
        renderProfileId: profile?.id ?? null,
        renderVersion: profile?.profileVersion ?? 1,
        width: width ?? null,
        height: height ?? null,
        hasWatermark,
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

  private uniqueSizes(sizes: Array<{ width: number; height: number }>) {
    const seen = new Set<number>();
    return sizes.filter((size) => !seen.has(size.width) && seen.add(size.width));
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
    const margin = Math.round(config.margin * unitScale);
    // Measured at 4x so rounding of the rasterised width does not skew the final size.
    const tileScale = config.repeat
      ? unitScale
      : getSingleWatermarkTileScale(
          (await this.renderWatermarkTile(config, text, logo, 4, false)).width / 4,
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

    const fitted = fitWithin(
      tile.width,
      tile.height,
      baseWidth - margin * 2,
      baseHeight - margin * 2,
    );
    const resized =
      fitted.width === tile.width && fitted.height === tile.height
        ? { data: tile.buffer, info: { width: tile.width, height: tile.height } }
        : await sharp(tile.buffer)
            .resize({ width: fitted.width, height: fitted.height, fit: 'inside' })
            .png()
            .toBuffer({ resolveWithObject: true });
    const position = getOverlayPosition(
      baseWidth,
      baseHeight,
      resized.info.width,
      resized.info.height,
      config.position,
      margin,
    );
    return {
      buffer: resized.data,
      width: resized.info.width,
      height: resized.info.height,
      ...position,
    };
  }

  /**
   * Renders the logo + text tile at `config.fontSize * scale`, cropped to the drawn width.
   * When `finalize` is set the tile is also rotated and faded to the configured opacity.
   */
  private async renderWatermarkTile(
    config: WatermarkConfig,
    text: string,
    logo: { buffer: Buffer; mimeType: string } | null,
    scale: number,
    finalize: boolean,
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    const fontSize = Math.max(1, config.fontSize * scale);
    const geometry = getWatermarkTileGeometry(fontSize, Boolean(logo));
    const canvasWidth = Math.max(1, Math.ceil(geometry.textX + (text.length + 2) * fontSize * 1.2));
    const canvasHeight = Math.max(1, Math.ceil(geometry.height));
    const logoSvg = logo
      ? `<image href="data:${logo.mimeType};base64,${logo.buffer.toString('base64')}" x="0" y="${geometry.logoY}" width="${geometry.logoSize}" height="${geometry.logoSize}" preserveAspectRatio="xMidYMid meet"/>`
      : '';
    const textSvg = text
      ? `<text x="${geometry.textX}" y="${geometry.textBaselineY}" fill="${this.escapeXml(
          config.color,
        )}" font-family="${this.escapeXml(config.fontFamily)}" font-size="${fontSize}">${this.escapeXml(text)}</text>`
      : '';
    const drawn = await sharp(
      Buffer.from(
        `<svg width="${canvasWidth}" height="${canvasHeight}" xmlns="http://www.w3.org/2000/svg">${logoSvg}${textSvg}</svg>`,
      ),
    )
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

    const rotated = await sharp(cropped)
      .rotate(config.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
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

  private runProcess(
    command: string | null,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    if (!command) {
      return Promise.reject(new Error('FFmpeg binary is not available'));
    }
    const timeoutMs = this.config.getOrThrow<number>('MEDIA_RENDER_TIMEOUT_SECONDS') * 1000;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Media processing timed out'));
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(stderr || `Media command exited with code ${code ?? 'unknown'}`));
        }
      });
    });
  }
}
