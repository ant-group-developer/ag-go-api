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
            ? await this.processImage(asset, tempPath)
            : await this.processVideo(asset, tempPath);

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

  private async processImage(asset: AssetEntity, inputPath: string): Promise<MediaMetadata> {
    const metadata = await sharp(inputPath, { failOn: 'error' }).metadata();

    await this.createImageVariant(
      asset,
      inputPath,
      'preview',
      this.config.getOrThrow<number>('MEDIA_PREVIEW_MAX_WIDTH'),
      this.config.getOrThrow<number>('MEDIA_PREVIEW_MAX_HEIGHT'),
    );
    await this.createImageVariant(
      asset,
      inputPath,
      'thumbnail',
      this.config.getOrThrow<number>('MEDIA_THUMBNAIL_MAX_WIDTH'),
      this.config.getOrThrow<number>('MEDIA_THUMBNAIL_MAX_HEIGHT'),
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
  ): Promise<void> {
    const resizedBuffer = await sharp(inputPath)
      .rotate()
      .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    const resizedMetadata = await sharp(resizedBuffer).metadata();
    const output = await sharp(resizedBuffer)
      .composite([{ input: this.createWatermark(resizedMetadata.width ?? maxWidth) , gravity: 'southeast' }])
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
      true,
    );
  }

  private async processVideo(asset: AssetEntity, inputPath: string): Promise<MediaMetadata> {
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
      const poster = await sharp(posterBuffer)
        .composite([
          {
            input: this.createWatermark(posterMetadata.width ?? 320),
            gravity: 'southeast',
          },
        ])
        .jpeg({ quality: 82 })
        .toBuffer();
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
        true,
      );
    } finally {
      await fs.rm(posterPath, { force: true });
    }

    const previewExtension = asset.extension || 'mp4';
    const previewKey = `variants/${asset.id}/preview.${previewExtension}`;
    const previewPath = join(tmpdir(), `ag-go-preview-${asset.id}-${Date.now()}.${previewExtension}`);
    await this.runProcess(ffmpegPath, [
      '-y',
      '-i',
      inputPath,
      '-vf',
      "drawtext=text='AG Go Preview':fontcolor=white@0.75:fontsize=24:box=1:boxcolor=black@0.42:boxborderw=12:x=20:y=20",
      '-c:a',
      'copy',
      previewPath,
    ]);
    const preview = await fs.readFile(previewPath);
    const previewHead = await this.storage.putObject(previewKey, preview, asset.mimeType);
    await fs.rm(previewPath, { force: true });
    await this.saveVariant(
      asset,
      'preview',
      previewKey,
      asset.mimeType,
      previewHead.sizeBytes,
      width,
      height,
      true,
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
  ): Promise<void> {
    const existing = await this.variantRepository.findOne({
      where: { assetId: asset.id, variantCode },
    });
    await this.variantRepository.save(
      this.variantRepository.create({
        id: existing?.id ?? uuidv7(),
        assetId: asset.id,
        renderProfileId: null,
        variantCode,
        renderVersion: 1,
        storageProvider: asset.storageProvider,
        bucketName: asset.originalBucket,
        storageKey,
        mimeType,
        fileSizeBytes: String(sizeBytes),
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

  private createWatermark(baseWidth: number): Buffer {
    const width = Math.max(1, Math.min(baseWidth, 520));
    const height = Math.max(32, Math.min(90, Math.round(width * 0.17)));
    const fontSize = Math.max(12, Math.round(height * 0.38));
    return Buffer.from(`
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="${width}" height="${height}" rx="${Math.round(height * 0.12)}" fill="rgba(0,0,0,0.42)"/>
        <text x="${Math.round(height * 0.26)}" y="${Math.round(height * 0.64)}" fill="white"
          font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700">
          AG Go Preview
        </text>
      </svg>
    `);
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
