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
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import {
  normalizeWatermarkConfig,
  type WatermarkConfig,
} from '../render/watermark-config';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage/storage-adapter';

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
        : await this.renderProfileRepository.findOne({
            where: { code: 'default', isActive: true },
            order: { profileVersion: 'DESC' },
          });

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

        const metadata =
          asset.assetType === 'image'
            ? await this.processImage(asset, tempPath, profile)
            : await this.processVideo(asset, tempPath, profile);

        await this.assetRepository.update(asset.id, {
          processingStatus: 'ready',
          processingError: null,
          sourceMetadata: metadata,
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
  ): Promise<MediaMetadata> {
    const metadata = await sharp(inputPath, { failOn: 'error' }).metadata();

    await this.createImageVariant(
      asset,
      inputPath,
      'preview',
      this.config.getOrThrow<number>('MEDIA_PREVIEW_MAX_WIDTH'),
      this.config.getOrThrow<number>('MEDIA_PREVIEW_MAX_HEIGHT'),
      profile,
    );
    await this.createImageVariant(
      asset,
      inputPath,
      'thumbnail',
      this.config.getOrThrow<number>('MEDIA_THUMBNAIL_MAX_WIDTH'),
      this.config.getOrThrow<number>('MEDIA_THUMBNAIL_MAX_HEIGHT'),
      profile,
    );

    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    };
  }

  private async createImageVariant(
    asset: AssetEntity,
    inputPath: string,
    variantCode: 'thumbnail' | 'preview',
    maxWidth: number,
    maxHeight: number,
    profile: RenderProfileEntity | null,
  ): Promise<void> {
    const config = normalizeWatermarkConfig(profile?.watermarkConfig);
    const configuredMaxWidth = config.maxWidth ?? maxWidth;
    const resizedBuffer = await sharp(inputPath)
      .rotate()
      .resize({
        width: Math.min(maxWidth, configuredMaxWidth),
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    const resizedMetadata = await sharp(resizedBuffer).metadata();
    const watermark = await this.createWatermark(
      resizedMetadata.width ?? maxWidth,
      resizedMetadata.height ?? maxHeight,
      profile,
    );
    const image = sharp(resizedBuffer);
    if (watermark) {
      image.composite([
        {
          input: watermark.buffer,
          top: watermark.top,
          left: watermark.left,
        },
      ]);
    }
    const output = await image
      .webp({ quality: variantCode === 'thumbnail' ? 75 : 85 })
      .toBuffer({ resolveWithObject: true });
    const storageKey = `variants/${asset.id}/${variantCode}.webp`;
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
  }

  private async processVideo(
    asset: AssetEntity,
    inputPath: string,
    profile: RenderProfileEntity | null,
  ): Promise<MediaMetadata> {
    const watermarkConfig = normalizeWatermarkConfig(profile?.watermarkConfig);
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

    const posterPath = join(tmpdir(), `ag-go-poster-${asset.id}-${Date.now()}.jpg`);
    const renderWidth = Math.min(width ?? 320, watermarkConfig.maxWidth ?? width ?? 320);
    const renderHeight =
      width && height && renderWidth !== width
        ? Math.max(2, Math.round((height * renderWidth) / width))
        : height ?? 180;
    const watermark = await this.createWatermark(renderWidth, renderHeight, profile);
    const watermarkPath = watermark
      ? join(tmpdir(), `ag-go-watermark-${asset.id}-${Date.now()}.png`)
      : undefined;
    try {
      await this.runProcess(ffmpegPath, [
        '-y',
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${this.config.getOrThrow<number>('MEDIA_THUMBNAIL_MAX_WIDTH')},iw)':-2`,
        posterPath,
      ]);
      const posterBuffer = await fs.readFile(posterPath);
      const posterMetadata = await sharp(posterBuffer).metadata();
      const posterImage = sharp(posterBuffer);
      const posterWatermark = await this.createWatermark(
        posterMetadata.width ?? 320,
        posterMetadata.height ?? 180,
        profile,
      );
      if (posterWatermark) {
        const posterPosition = this.getOverlayPosition(
          posterMetadata.width ?? 320,
          posterMetadata.height ?? 180,
          posterWatermark.width,
          posterWatermark.height,
          watermarkConfig,
        );
        posterImage.composite([
          {
            input: posterWatermark.buffer,
            top: posterPosition.top,
            left: posterPosition.left,
          },
        ]);
      }
      const poster = await posterImage.jpeg({ quality: 82 }).toBuffer();
      const posterKey = `variants/${asset.id}/thumbnail.jpg`;
      const posterHead = await this.storage.putObject(posterKey, poster, 'image/jpeg');
      await this.saveVariant(
        asset,
        'thumbnail',
        posterKey,
        'image/jpeg',
        posterHead.sizeBytes,
        width,
        height,
        Boolean(watermark),
        profile,
      );
    } finally {
      await fs.rm(posterPath, { force: true });
    }

    const previewExtension = asset.extension || 'mp4';
    const previewKey = `variants/${asset.id}/preview.${previewExtension}`;
    const previewPath = join(tmpdir(), `ag-go-preview-${asset.id}-${Date.now()}.${previewExtension}`);
    if (watermark && watermarkPath) {
      await fs.writeFile(watermarkPath, watermark.buffer);
      const filter = this.getVideoOverlayFilter(
        watermarkConfig,
      );
      await this.runProcess(ffmpegPath, [
        '-y',
        '-i',
        inputPath,
        '-i',
        watermarkPath,
        '-filter_complex',
        `[0:v]scale=${renderWidth}:${renderHeight}[base];[base][1:v]${filter}[v]`,
        '-map',
        '[v]',
        '-map',
        '0:a?',
        '-c:a',
        'copy',
        previewPath,
      ]);
    } else {
      await this.runProcess(ffmpegPath, ['-y', '-i', inputPath, '-c', 'copy', previewPath]);
    }
    const preview = await fs.readFile(previewPath);
    const previewHead = await this.storage.putObject(previewKey, preview, asset.mimeType);
    await fs.rm(previewPath, { force: true });
    if (watermarkPath) {
      await fs.rm(watermarkPath, { force: true });
    }
    await this.saveVariant(
      asset,
      'preview',
      previewKey,
      asset.mimeType,
      previewHead.sizeBytes,
      width,
      height,
      Boolean(watermark),
      profile,
    );

    return {
      width,
      height,
      durationSeconds,
      format: parsed.format?.format_name,
      codec: videoStream?.codec_name,
      frameRate,
    };
  }

  private async saveVariant(
    asset: AssetEntity,
    variantCode: 'thumbnail' | 'preview',
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

  private parseFrameRate(value: string): number | undefined {
    const [numerator, denominator] = value.split('/').map(Number);
    if (!numerator || !denominator) {
      return undefined;
    }
    return numerator / denominator;
  }

  private async createWatermark(
    baseWidth: number,
    baseHeight: number,
    profile: RenderProfileEntity | null,
  ): Promise<{ buffer: Buffer; width: number; height: number; top: number; left: number } | null> {
    if (!profile?.watermarkEnabled) {
      return null;
    }
    const config = normalizeWatermarkConfig(profile.watermarkConfig);
    if (!config.text && !config.logoAssetId) {
      return null;
    }
    const logo = config.logoAssetId
      ? await this.assetRepository.findOne({ where: { id: config.logoAssetId } })
      : null;
    const logoData = logo
      ? await this.readLogoData(logo.originalStorageKey, logo.mimeType)
      : undefined;
    const safeText = this.escapeXml(config.text.slice(0, 120));
    const textWidth = Math.max(1, safeText.length * config.fontSize * 0.68 + config.fontSize);
    const logoWidth = logoData ? Math.max(16, Math.round(config.fontSize * 1.6)) : 0;
    const textGap = logoWidth ? Math.round(logoWidth * 0.3) : 0;
    const tileWidth = Math.max(
      config.fontSize,
      Math.ceil((logoWidth ? logoWidth + textGap : 0) + textWidth),
    );
    const tileHeight = Math.max(
      config.fontSize * 1.5,
      logoWidth || 0,
      config.fontSize * 1.4,
    );
    const logoSvg = logoData
      ? `<image href="data:${logoData.mimeType};base64,${logoData.buffer.toString('base64')}" x="0" y="${Math.max(
          0,
          Math.round((tileHeight - logoWidth) / 2),
        )}" width="${logoWidth}" height="${logoWidth}" preserveAspectRatio="xMidYMid meet"/>`
      : '';
    const textSvg = safeText
      ? `<text x="${logoWidth ? logoWidth + textGap : 0}" y="${Math.round(tileHeight / 2 + config.fontSize * 0.35)}" fill="${this.escapeXml(
          config.color,
        )}" fill-opacity="${config.opacity}" font-family="${this.escapeXml(
          config.fontFamily,
        )}" font-size="${config.fontSize}">${safeText}</text>`
      : '';
    const rotatedTile = await sharp(
      Buffer.from(
        `<svg width="${tileWidth}" height="${Math.ceil(tileHeight)}" xmlns="http://www.w3.org/2000/svg">${logoSvg}${textSvg}</svg>`,
      ),
    )
      .rotate(config.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const rotatedMeta = await sharp(rotatedTile).metadata();
    const tileW = Math.max(1, rotatedMeta.width ?? tileWidth);
    const tileH = Math.max(1, rotatedMeta.height ?? Math.ceil(tileHeight));

    if (config.repeat) {
      const columns = Math.ceil(baseWidth / (tileW + config.gapX)) + 2;
      const rows = Math.ceil(baseHeight / (tileH + config.gapY)) + 2;
      const items: string[] = [];
      const href = `data:image/png;base64,${rotatedTile.toString('base64')}`;
      for (let y = -tileH; y < baseHeight + tileH && items.length < columns * rows; y += tileH + config.gapY) {
        for (let x = -tileW; x < baseWidth + tileW; x += tileW + config.gapX) {
          items.push(`<image href="${href}" x="${x}" y="${y}" width="${tileW}" height="${tileH}"/>`);
        }
      }
      const repeated = Buffer.from(
        `<svg width="${baseWidth}" height="${baseHeight}" xmlns="http://www.w3.org/2000/svg">${items.join('')}</svg>`,
      );
      return {
        buffer: await sharp(repeated).png().toBuffer(),
        width: baseWidth,
        height: baseHeight,
        top: 0,
        left: 0,
      };
    }

    const width = Math.min(baseWidth, Math.max(1, Math.round(tileW * Math.min(1, config.scale / 0.28))));
    const height = Math.min(baseHeight, Math.max(1, Math.round(tileH * (width / tileW))));
    const compact = await sharp(rotatedTile)
      .resize({ width, height, fit: 'inside' })
      .png()
      .toBuffer();
    const position = this.getOverlayPosition(
      baseWidth,
      baseHeight,
      width,
      height,
      config,
    );
    return { buffer: compact, width, height, ...position };
  }

  private async readLogoData(storageKey: string, mimeType: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of this.storage.readObject(storageKey)) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), mimeType };
  }

  private getOverlayPosition(
    baseWidth: number,
    baseHeight: number,
    overlayWidth: number,
    overlayHeight: number,
    config: WatermarkConfig,
  ) {
    const margin = config.margin;
    switch (config.position) {
      case 'top-left':
        return { top: margin, left: margin };
      case 'top-right':
        return { top: margin, left: Math.max(0, baseWidth - overlayWidth - margin) };
      case 'bottom-left':
        return { top: Math.max(0, baseHeight - overlayHeight - margin), left: margin };
      case 'center':
        return {
          top: Math.max(0, Math.round((baseHeight - overlayHeight) / 2)),
          left: Math.max(0, Math.round((baseWidth - overlayWidth) / 2)),
        };
      case 'bottom-right':
      default:
        return {
          top: Math.max(0, baseHeight - overlayHeight - margin),
          left: Math.max(0, baseWidth - overlayWidth - margin),
        };
    }
  }

  private getVideoOverlayFilter(config: WatermarkConfig): string {
    const margin = config.margin;
    switch (config.position) {
      case 'top-left':
        return `overlay=${margin}:${margin}:format=auto`;
      case 'top-right':
        return `overlay=main_w-overlay_w-${margin}:${margin}:format=auto`;
      case 'bottom-left':
        return `overlay=${margin}:main_h-overlay_h-${margin}:format=auto`;
      case 'center':
        return 'overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:format=auto';
      case 'bottom-right':
      default:
        return `overlay=main_w-overlay_w-${margin}:main_h-overlay_h-${margin}:format=auto`;
    }
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
