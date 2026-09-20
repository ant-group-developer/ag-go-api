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
      throw error;
    }
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
    const output = await sharp(inputPath)
      .rotate()
      .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
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
      const poster = await fs.readFile(posterPath);
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
      );
    } finally {
      await fs.rm(posterPath, { force: true });
    }

    const previewKey = `variants/${asset.id}/preview${asset.extension ? `.${asset.extension}` : ''}`;
    const previewHead = await this.storage.copyObject(asset.originalStorageKey, previewKey);
    await this.saveVariant(
      asset,
      'preview',
      previewKey,
      asset.mimeType,
      previewHead.sizeBytes,
      width,
      height,
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
        hasWatermark: false,
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
