import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import {
  STORAGE_ADAPTER,
  type StorageAdapter,
  type UploadedPart,
} from '../assets/storage/storage-adapter';
import { SystemLogService } from '../logs/system-log.service';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { isPreviewVariantCode } from '../render/render-sizes';
import { AI_MANIFEST_PATH, AI_TRACE_PATH } from './farm/scan';
import type { SignOp, SignResponse, SignResult } from './farm/sign';
import type { TicketClaims } from './farm/ticket';

/**
 * Short edges a clean preview may have to stand in for the original in scan.extract: from the
 * worker's proxy height (720p) up to 1080p. Smaller would blur the keyframes, larger saves little.
 */
const SCAN_PREVIEW_SHORT_EDGE_MIN = 720;
const SCAN_PREVIEW_SHORT_EDGE_MAX = 1080;

/**
 * Handles URL signing for farm workers accessing the analysis prefix.
 * Called from POST /analysis/farm/sign after the FarmTicketGuard approves.
 */
@Injectable()
export class AnalysisSignService {
  private readonly logger = new Logger(AnalysisSignService.name);

  constructor(
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepo: Repository<AssetVariantEntity>,
    @InjectRepository(AnalysisFarmJobEntity)
    private readonly farmJobRepo: Repository<AnalysisFarmJobEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly config: ConfigService,
    private readonly systemLog: SystemLogService,
  ) {}

  async sign(
    claims: TicketClaims,
    job: AnalysisFarmJobEntity,
    ops: SignOp[],
    requestId?: string,
  ): Promise<SignResponse> {
    const analysis = await this.analysisRepo.findOne({ where: { id: job.analysisId } });
    if (!analysis) {
      throw new NotFoundException(`Analysis ${job.analysisId} not found`);
    }
    const asset = await this.assetRepo.findOne({ where: { id: analysis.assetId } });
    if (!asset) {
      throw new NotFoundException(`Asset ${analysis.assetId} not found`);
    }

    const analysisPrefix = `${assetVariantsPrefix(asset.originalStorageKey, asset.id)}analysis/${analysis.id}/`;
    const ttl = this.config.get<number>('FARM_URL_TTL_SECONDS') ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    // Authorize every op before running any: mp_create/mp_complete/mp_abort touch storage, so a
    // request with one forbidden op must be refused as a whole before anything happens.
    for (const op of ops) {
      this.authorizeOp(op, job);
    }

    const results: SignResult[] = [];
    for (const op of ops) {
      const result = await this.signOp(op, analysis, asset, analysisPrefix, ttl, expiresAt);
      results.push(result);
    }

    // Audit
    await this.systemLog.write({
      level: 'info',
      category: 'farm_sign',
      action: 'farm.sign',
      message: `Farm sign: job ${claims.job_id} type=${claims.type} ops=${ops.length}`,
      requestId,
      userId: null,
      metadata: { jobId: claims.job_id, type: claims.type, opsCount: ops.length },
    });

    return { results };
  }

  private async signOp(
    op: SignOp,
    analysis: AssetAnalysisEntity,
    asset: AssetEntity,
    analysisPrefix: string,
    ttl: number,
    expiresAt: string,
  ): Promise<SignResult> {
    if (op.op === 'get') {
      return this.signGet(op.input, analysis, asset, ttl, expiresAt, analysisPrefix);
    }

    // Write ops land under the analysis prefix; authorizeOp already checked the path.
    const output = op.output;

    if (op.op === 'put') {
      const url = await this.storage.getPresignedPutUrl(
        `${analysisPrefix}${output}`,
        op.content_type,
        ttl,
      );
      return {
        op: 'put',
        output,
        url,
        expires_at: expiresAt,
        headers: { 'Content-Type': op.content_type },
      };
    }

    if (op.op === 'mp_create') {
      const uploadId = await this.storage.createMultipartUpload(
        `${analysisPrefix}${output}`,
        op.content_type,
      );
      return { op: 'mp_create', output, upload_id: uploadId };
    }

    if (op.op === 'mp_part_urls') {
      const urls = await Promise.all(
        op.parts.map(async (partNumber) => ({
          part_number: partNumber,
          url: await this.storage.getPresignedUploadPartUrl(
            `${analysisPrefix}${output}`,
            op.upload_id,
            partNumber,
            ttl,
          ),
        })),
      );
      return { op: 'mp_part_urls', output, upload_id: op.upload_id, expires_at: expiresAt, urls };
    }

    if (op.op === 'mp_complete') {
      const parts: UploadedPart[] = op.parts.map((p) => ({
        partNumber: p.part_number,
        etag: p.etag,
        sizeBytes: 0,
      }));
      await this.storage.completeMultipartUpload(`${analysisPrefix}${output}`, op.upload_id, parts);
      return { op: 'mp_complete', output };
    }

    if (op.op === 'mp_abort') {
      await this.storage.abortMultipartUpload(`${analysisPrefix}${output}`, op.upload_id);
      return { op: 'mp_abort', output };
    }

    throw new ForbiddenException(`Unknown sign op: ${(op as { op: string }).op}`);
  }

  private async signGet(
    input: string,
    analysis: AssetAnalysisEntity,
    asset: AssetEntity,
    ttl: number,
    expiresAt: string,
    analysisPrefix: string,
  ): Promise<SignResult> {
    if (input === 'source') {
      // A clean rendered preview spares the worker the original (often 4K) and its proxy encode
      const preview = await this.signScanPreview(input, asset, ttl, expiresAt);
      if (preview) return preview;

      // The original (unwatermarked) asset file
      const head = await this.storage.headObject(asset.originalStorageKey);
      const url = await this.storage.getPresignedGetUrl(
        asset.originalStorageKey,
        asset.mimeType,
        ttl,
      );
      const cacheKey = asset.checksumSha256 ?? `${asset.id}:${asset.fileSizeBytes}`;
      return {
        op: 'get',
        input,
        url,
        expires_at: expiresAt,
        size_bytes: head?.sizeBytes ?? null,
        content_type: asset.mimeType,
        cache_key: cacheKey,
        source: {
          source_kind: 'original',
          watermarked: false,
          start_ms: null,
          end_ms: null,
        },
      };
    }

    if (input.startsWith('artifact:')) {
      const path = input.slice('artifact:'.length);
      // Must not escape the analysis prefix
      if (!this.isPathSafe(path)) {
        throw new ForbiddenException(`Artifact path is not safe: ${path}`);
      }
      const storageKey = `${analysisPrefix}${path}`;
      const head = await this.storage.headObject(storageKey);
      const contentType = guessContentType(path);
      const url = await this.storage.getPresignedGetUrl(storageKey, contentType, ttl);
      return {
        op: 'get',
        input,
        url,
        expires_at: expiresAt,
        size_bytes: head?.sizeBytes ?? null,
        content_type: contentType,
        cache_key: null,
        source: null,
      };
    }

    throw new ForbiddenException(`Unknown or disallowed get input: ${input}`);
  }

  /**
   * The `source` read served from a rendered preview: the smallest ready, unwatermarked video
   * preview with a 720p–1080p short edge that is smaller than the original. Same timeline and
   * audio as the original, so scenes, keyframe times and silence still hold. Null when the asset
   * has none (or its file is missing), and the original is served instead.
   */
  private async signScanPreview(
    input: string,
    asset: AssetEntity,
    ttl: number,
    expiresAt: string,
  ): Promise<SignResult | null> {
    if (asset.assetType !== 'video') return null;
    const originalBytes = Number(asset.fileSizeBytes) || Number.POSITIVE_INFINITY;
    const variants = await this.variantRepo.find({
      where: { assetId: asset.id, status: 'ready', hasWatermark: false },
    });
    const preview = variants
      .filter((variant) => {
        if (!isPreviewVariantCode(variant.variantCode)) return false;
        if (!variant.mimeType.startsWith('video/') || !variant.width || !variant.height) {
          return false;
        }
        const shortEdge = Math.min(variant.width, variant.height);
        const bytes = Number(variant.fileSizeBytes);
        return (
          shortEdge >= SCAN_PREVIEW_SHORT_EDGE_MIN &&
          shortEdge <= SCAN_PREVIEW_SHORT_EDGE_MAX &&
          bytes > 0 &&
          bytes < originalBytes
        );
      })
      .sort((a, b) => Number(a.fileSizeBytes) - Number(b.fileSizeBytes))[0];
    if (!preview) return null;

    const head = await this.storage.headObject(preview.storageKey);
    if (!head) {
      this.logger.warn(
        `Preview ${preview.variantCode} of asset ${asset.id} is missing in storage, scanning the original`,
      );
      return null;
    }
    const url = await this.storage.getPresignedGetUrl(preview.storageKey, preview.mimeType, ttl);
    return {
      op: 'get',
      input,
      url,
      expires_at: expiresAt,
      size_bytes: head.sizeBytes,
      content_type: preview.mimeType,
      // A re-render keeps the variant row but changes the file
      cache_key: `${preview.id}:${new Date(preview.updatedAt).getTime()}:${head.sizeBytes}`,
      source: {
        source_kind: 'preview',
        watermarked: false,
        start_ms: null,
        end_ms: null,
      },
    };
  }

  /**
   * Throws unless the op is allowed for this farm job:
   * - `get source` (the clean original) only for scan.extract; scan.ai works from keyframes;
   * - `get artifact:<path>` for a safe path under the analysis prefix;
   * - writes only under the analysis prefix, and scan.ai only its manifest (ai.json) or
   *   its training-data trace (ai-trace.json).
   */
  authorizeOp(op: SignOp, job: AnalysisFarmJobEntity): void {
    if (op.op === 'get') {
      if (op.input === 'source') {
        if (job.type !== 'scan.extract') {
          throw new ForbiddenException(`${job.type} jobs cannot read the original file`);
        }
        return;
      }
      if (op.input.startsWith('artifact:')) {
        const path = op.input.slice('artifact:'.length);
        if (!this.isPathSafe(path)) {
          throw new ForbiddenException(`Artifact path is not safe: ${path}`);
        }
        return;
      }
      throw new ForbiddenException(`Unknown or disallowed get input: ${op.input}`);
    }

    if (!this.isPathSafe(op.output)) {
      throw new ForbiddenException(`Output path is not safe: ${op.output}`);
    }
    if (job.type === 'scan.ai' && op.output !== AI_MANIFEST_PATH && op.output !== AI_TRACE_PATH) {
      throw new ForbiddenException(
        `scan.ai job may only write ${AI_MANIFEST_PATH} or ${AI_TRACE_PATH}, not ${op.output}`,
      );
    }
  }

  private isPathSafe(path: string): boolean {
    if (!path || path.includes('..') || path.includes('\\')) return false;
    const segments = path.split('/');
    return !segments.some((s) => s === '' || s === '.' || s === '..');
  }
}

function guessContentType(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.mp4') || path.endsWith('.m4v')) return 'video/mp4';
  return 'application/octet-stream';
}
