import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetAnalysisEntity } from '../../../database/entities/asset-analysis.entity';
import { AssetPrepFarmJobEntity } from '../../../database/entities/asset-prep-farm-job.entity';
import { AssetPrepEntity } from '../../../database/entities/asset-prep.entity';
import { AssetVariantEntity } from '../../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../../database/entities/asset.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../../assets/storage/storage-adapter';
import { pickRendition, shortEdgeOf, type Rendition } from '../../footage/resolve-prefer';
import { SystemLogService } from '../../logs/system-log.service';
import { assetVariantsPrefix } from '../../projects/project-asset-cleanup';
import { isPreviewVariantCode, variantResolution } from '../../render/render-sizes';
import { guessContentType, isSafeRelativePath, signWriteOp } from '../farm-sign-ops';
import { PREP_AUDIO_PATH, PREP_MANIFEST_PATH } from '../farm/scan';
import type { SignOp, SignResponse, SignResult } from '../farm/sign';
import { TRANSCRIBE_MANIFEST_PATH } from '../farm/studio';
import type { TicketClaims } from '../farm/ticket';
import { PREP_JOB_TYPES, prepPrefix } from './prep-batches';

/** Short edge scan.prep wants to read: the frames are 480 px wide. */
const PREP_SOURCE_SHORT_EDGE = 480;
/** Height of the analysis proxy the scan worker encodes (when the source is higher). */
const PROXY_HEIGHT = 720;

/** What scan.prep may write: one frame per shot, the sheets, its manifest and the audio track. */
const PREP_OUTPUT =
  /^(frames\/[A-Za-z0-9_-]+\.jpg|sheets\/[A-Za-z0-9_-]+\.jpg|prep\.json|audio\.wav)$/;

type GetSignResult = Extract<SignResult, { op: 'get' }>;

type SourceRef =
  | { kind: 'variant'; variant: AssetVariantEntity }
  | { kind: 'proxy'; key: string; analysisId: string }
  | { kind: 'original' };

/**
 * URL signing for the farm jobs of a prep, under `<variants>/prep/<prepId>/`:
 * - scan.prep reads `source` (the smallest clean file with a short edge of at least 480 px: a clean
 *   rendition, else the analysis proxy, else the original) and writes `frames/`, `sheets/`,
 *   `prep.json` and `audio.wav`;
 * - studio.transcribe reads `artifact:audio.wav` and writes `transcribe.json`.
 */
@Injectable()
export class PrepSignService {
  private readonly logger = new Logger(PrepSignService.name);

  constructor(
    @InjectRepository(AssetPrepEntity)
    private readonly prepRepo: Repository<AssetPrepEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepo: Repository<AssetVariantEntity>,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly config: ConfigService,
    private readonly systemLog: SystemLogService,
  ) {}

  async sign(
    claims: TicketClaims,
    job: AssetPrepFarmJobEntity,
    ops: SignOp[],
    requestId?: string,
  ): Promise<SignResponse> {
    // Refused as a whole before anything touches storage
    for (const op of ops) this.authorizeOp(op, job);

    const prep = await this.prepRepo.findOne({ where: { id: job.prepId } });
    if (!prep) throw new NotFoundException(`Prep ${job.prepId} not found`);
    const asset = await this.assetRepo.findOne({ where: { id: prep.assetId } });
    if (!asset) throw new NotFoundException(`Asset ${prep.assetId} not found`);

    const variantsPrefix = assetVariantsPrefix(asset.originalStorageKey, asset.id);
    const prefix = prepPrefix(variantsPrefix, prep.id);
    const ttl = this.config.get<number>('FARM_URL_TTL_SECONDS') ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const results: SignResult[] = [];
    for (const op of ops) {
      if (op.op !== 'get') {
        results.push(await signWriteOp(this.storage, op, prefix, ttl, expiresAt));
      } else if (op.input === 'source') {
        results.push(await this.signSource(prep, asset, variantsPrefix, ttl, expiresAt));
      } else {
        const path = op.input.slice('artifact:'.length);
        const key = `${prefix}${path}`;
        const head = await this.storage.headObject(key);
        const contentType = guessContentType(path);
        results.push({
          op: 'get',
          input: op.input,
          url: await this.storage.getPresignedGetUrl(key, contentType, ttl),
          expires_at: expiresAt,
          size_bytes: head?.sizeBytes ?? null,
          content_type: contentType,
          cache_key: null,
          source: null,
        });
      }
    }

    // One audit line per read or manifest, not one per uploaded frame
    const notable = ops.some(
      (op) =>
        op.op === 'get' ||
        (op.op !== 'mp_part_urls' &&
          (op.output === PREP_MANIFEST_PATH || op.output === TRANSCRIBE_MANIFEST_PATH)),
    );
    if (notable) {
      await this.systemLog
        .write({
          level: 'info',
          category: 'farm_sign',
          action: 'farm.sign',
          message: `Farm sign: job ${claims.job_id} type=${claims.type} ops=${ops.length}`,
          requestId,
          userId: null,
          metadata: {
            jobId: claims.job_id,
            type: claims.type,
            opsCount: ops.length,
            prepId: prep.id,
          },
        })
        .catch(() => undefined);
    }
    return { results };
  }

  /** Throws unless the op is allowed for this prep job (see the class comment). */
  authorizeOp(op: SignOp, job: AssetPrepFarmJobEntity): void {
    if (op.op === 'get') {
      if (op.input === 'source' && job.type === PREP_JOB_TYPES.prep) return;
      if (op.input === `artifact:${PREP_AUDIO_PATH}` && job.type === PREP_JOB_TYPES.transcribe) {
        return;
      }
      throw new ForbiddenException(`${job.type} jobs cannot read ${op.input}`);
    }
    if (!isSafeRelativePath(op.output)) {
      throw new ForbiddenException(`Output path is not safe: ${op.output}`);
    }
    const allowed =
      job.type === PREP_JOB_TYPES.prep
        ? PREP_OUTPUT.test(op.output)
        : job.type === PREP_JOB_TYPES.transcribe && op.output === TRANSCRIBE_MANIFEST_PATH;
    if (!allowed) {
      throw new ForbiddenException(`${job.type} job may not write ${op.output}`);
    }
  }

  /**
   * The `source` of scan.prep: the smallest clean file at least 480 px on its short edge. Frames
   * are cut from a clean file, the same for every Studio user. The file served is kept on the prep.
   */
  private async signSource(
    prep: AssetPrepEntity,
    asset: AssetEntity,
    variantsPrefix: string,
    ttl: number,
    expiresAt: string,
  ): Promise<SignResult> {
    let candidates = await this.sourceCandidates(asset, variantsPrefix);
    for (;;) {
      const picked = pickRendition(candidates, {
        short_edge: PREP_SOURCE_SHORT_EDGE,
        clean: true,
      });
      const ref = picked?.ref ?? { kind: 'original' as const };
      const served = await this.signRef(ref, asset, ttl, expiresAt);
      if (served) {
        await this.prepRepo.update(prep.id, {
          sourceKind: served.source?.source_kind ?? null,
          watermarked: false,
        });
        return served;
      }
      // The file is missing in storage: try the next best one
      candidates = candidates.filter((candidate) => candidate !== picked);
    }
  }

  private async sourceCandidates(
    asset: AssetEntity,
    variantsPrefix: string,
  ): Promise<Rendition<SourceRef>[]> {
    const candidates: Rendition<SourceRef>[] = [];
    if (asset.assetType === 'video') {
      const variants = await this.variantRepo.find({
        where: { assetId: asset.id, status: 'ready', hasWatermark: false },
      });
      for (const variant of variants) {
        if (
          variant.hasWatermark ||
          !isPreviewVariantCode(variant.variantCode) ||
          !variant.mimeType.startsWith('video/')
        ) {
          continue;
        }
        const shortEdge = variantResolution(variant);
        if (!shortEdge) continue;
        candidates.push({
          kind: 'preview',
          shortEdge,
          watermarked: false,
          ref: { kind: 'variant', variant },
        });
      }
    }
    const meta = (asset.sourceMetadata ?? {}) as { width?: unknown; height?: unknown };
    const analysis = await this.analysisRepo.findOne({
      where: { assetId: asset.id, isCurrent: true },
      select: { id: true },
    });
    if (analysis) {
      candidates.push({
        kind: 'proxy',
        shortEdge: proxyShortEdge(meta.width, meta.height),
        watermarked: false,
        ref: {
          kind: 'proxy',
          key: `${variantsPrefix}analysis/${analysis.id}/proxy.mp4`,
          analysisId: analysis.id,
        },
      });
    }
    candidates.push({
      kind: 'original',
      shortEdge: shortEdgeOf(meta.width, meta.height),
      watermarked: false,
      ref: { kind: 'original' },
    });
    return candidates;
  }

  /** Signs one candidate file; null when it is missing in storage (the original never is). */
  private async signRef(
    ref: SourceRef,
    asset: AssetEntity,
    ttl: number,
    expiresAt: string,
  ): Promise<GetSignResult | null> {
    const base = { op: 'get' as const, input: 'source', expires_at: expiresAt };
    const source = (kind: 'original' | 'proxy' | 'preview') => ({
      source_kind: kind,
      watermarked: false,
      start_ms: null,
      end_ms: null,
    });
    if (ref.kind === 'variant') {
      const v = ref.variant;
      const head = await this.storage.headObject(v.storageKey);
      if (!head) {
        this.logger.warn(`Preview ${v.variantCode} of asset ${asset.id} is missing in storage`);
        return null;
      }
      return {
        ...base,
        url: await this.storage.getPresignedGetUrl(v.storageKey, v.mimeType, ttl),
        size_bytes: head.sizeBytes,
        content_type: v.mimeType,
        // A re-render keeps the variant row but changes the file
        cache_key: `${v.id}:${new Date(v.updatedAt).getTime()}:${head.sizeBytes}`,
        source: source('preview'),
      };
    }
    if (ref.kind === 'proxy') {
      const head = await this.storage.headObject(ref.key).catch(() => null);
      if (!head) return null;
      return {
        ...base,
        url: await this.storage.getPresignedGetUrl(ref.key, 'video/mp4', ttl),
        size_bytes: head.sizeBytes,
        content_type: 'video/mp4',
        cache_key: `proxy:${ref.analysisId}:${head.sizeBytes}`,
        source: source('proxy'),
      };
    }
    const head = await this.storage.headObject(asset.originalStorageKey);
    return {
      ...base,
      url: await this.storage.getPresignedGetUrl(asset.originalStorageKey, asset.mimeType, ttl),
      size_bytes: head?.sizeBytes ?? null,
      content_type: asset.mimeType,
      cache_key: asset.checksumSha256 ?? `${asset.id}:${asset.fileSizeBytes}`,
      source: source('original'),
    };
  }
}

/** Short edge of the analysis proxy: 720 px high when the source is higher, else the source. */
function proxyShortEdge(width: unknown, height: unknown): number {
  const w = typeof width === 'number' && width > 0 ? width : null;
  const h = typeof height === 'number' && height > 0 ? height : null;
  if (!w || !h) return PROXY_HEIGHT;
  if (h > PROXY_HEIGHT)
    return shortEdgeOf(Math.round((w * PROXY_HEIGHT) / h), PROXY_HEIGHT) ?? PROXY_HEIGHT;
  return Math.min(w, h);
}
