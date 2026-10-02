import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ActorEnrichmentService, type ActorUser } from '../../common/actor-enrichment.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { isAdminUserType } from '../../common/auth/user-type';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { descriptionView, type DescriptionView } from '../analysis/description-view';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { FolderAccessService } from '../folders/folder-access.service';
import { SystemLogService } from '../logs/system-log.service';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import {
  comparePreviews,
  describePreview,
  isPreviewVariantCode,
  type PreviewDescription,
} from '../render/render-sizes';
import { findActiveRenderProfile, isVariantServable } from '../render/watermark-policy';
import type { FootageCatalogBodyDto } from './dto/catalog-query.dto';
import type {
  ResolveAssetsResponse,
  ResolvePurpose,
  ResolvedAssetItem,
} from './dto/resolve-assets.dto';
import type {
  FootageSearchQueryDto,
  FootageSortField,
  FootageSortOrder,
} from './dto/search-query.dto';
import { FootageScopeService } from './footage-scope.service';

/** One analysed video as footage (see the asset-level contract). */
export type FootageVideo = DescriptionView & {
  assetId: string;
  name: string;
  projectIds: string[];
  projectNames: string[];
  folderIds: string[];
  durationMs: number;
  width: number;
  height: number;
  orientation: string;
  hasAudio: boolean;
  hasSpeech: boolean | null;
  approved: boolean;
  analyzedAt: string;
  thumbnailUrl: string | null;
};

export type FacetValue = { value: string; label?: string; count: number };

/** Search filters (no paging/sorting); a facet leaves its own filter out. */
type FootageFilters = Omit<
  FootageSearchQueryDto,
  'limit' | 'cursor' | 'page' | 'sortBy' | 'sortOrder'
>;

/** A project the video is linked to, as the footage detail shows it. */
export type FootageProject = {
  id: string;
  name: string;
  description: string | null;
  evaluationStatus: string;
  /** Evaluation of this video within the project. */
  mediaEvaluationStatus: string;
  folderId: string;
  folderPath: string;
  categoryName: string | null;
  countryName: string | null;
  provinceName: string | null;
  tags: string[];
  ownerUserId: string;
  ownerUser: ActorUser | null;
  createdAt: string;
  updatedAt: string;
};

/** Technical metadata of the original file. */
export type FootageFileInfo = {
  filename: string;
  extension: string | null;
  mimeType: string;
  /** bigint as string. */
  fileSizeBytes: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  frameRate: number | null;
  codec: string | null;
  format: string | null;
  bitrateBps: number | null;
  hasAudio: boolean | null;
  sourceType: string;
  uploadedAt: string;
  uploadedBy: string;
  uploadedByUser: ActorUser | null;
  analyzedAt: string | null;
  analysisModel: string | null;
};

type VideoRow = {
  assetId: string;
  analysisId: string;
  name: string;
  storageKey: string;
  projectIds: string[];
  projectNames: string[];
  folderIds: string[];
  durationMs: number | null;
  width: number | null;
  height: number | null;
  orientation: string | null;
  hasAudio: boolean | null;
  hasSpeech: boolean | null;
  description: Record<string, unknown>;
  approved: boolean;
  analyzedAt: Date | string | null;
  keyframes: Array<{ output?: string; t_ms?: number }> | null;
};

/** Decode a base64url cursor into { offset: number } */
function decodeCursor(cursor: string | undefined): { offset: number } {
  if (!cursor) return { offset: 0 };
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { offset?: number };
    return { offset: typeof parsed.offset === 'number' ? parsed.offset : 0 };
  } catch {
    return { offset: 0 };
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

const WIDTH_SQL = `COALESCE(CAST(aa.artifacts -> 'media' ->> 'width' AS int), CAST(asst.source_metadata ->> 'width' AS int))`;
const HEIGHT_SQL = `COALESCE(CAST(aa.artifacts -> 'media' ->> 'height' AS int), CAST(asst.source_metadata ->> 'height' AS int))`;
/** Short edge of the frame in px, what a resolution class is told by. */
const SHORT_EDGE_SQL = `LEAST(${WIDTH_SQL}, ${HEIGHT_SQL})`;
/** Resolution class (see `FOOTAGE_RESOLUTIONS`); NULL when the frame size is unknown. */
const RESOLUTION_CLASS_SQL = `CASE
    WHEN ${SHORT_EDGE_SQL} IS NULL THEN NULL
    WHEN ${SHORT_EDGE_SQL} >= 2160 THEN '4k'
    WHEN ${SHORT_EDGE_SQL} >= 1440 THEN '2k'
    WHEN ${SHORT_EDGE_SQL} >= 1080 THEN '1080p'
    WHEN ${SHORT_EDGE_SQL} >= 720 THEN '720p'
    ELSE 'sd'
  END`;

/**
 * Order of a video's projects (one row each, `project_media` is unique per project): folder
 * path then project name, as the project list sorts by folder. The first one is what the
 * folder sort reads.
 */
const PROJECT_ORDER_SQL = `fo.path_text COLLATE natural_sort NULLS LAST, p.name COLLATE natural_sort, p.id`;

/** Columns of a FootageVideo row; needs `aa` (current asset_analyses), `asst` (assets), `p`, `pm`, `fo`, `visible_projects`. */
function videoSelect(approvedExists: string): string {
  return `
    aa.asset_id                              AS "assetId",
    aa.id                                    AS "analysisId",
    asst.original_filename                   AS "name",
    asst.original_storage_key                AS "storageKey",
    array_agg(p.id ORDER BY ${PROJECT_ORDER_SQL})        AS "projectIds",
    array_agg(p.name ORDER BY ${PROJECT_ORDER_SQL})      AS "projectNames",
    array_agg(p.folder_id ORDER BY ${PROJECT_ORDER_SQL}) AS "folderIds",
    aa.duration_ms                           AS "durationMs",
    ${WIDTH_SQL}                             AS "width",
    ${HEIGHT_SQL}                            AS "height",
    aa.orientation                           AS "orientation",
    aa.has_audio                             AS "hasAudio",
    aa.has_speech                            AS "hasSpeech",
    aa.description                           AS "description",
    (${approvedExists})                      AS "approved",
    aa.completed_at                          AS "analyzedAt",
    aa.keyframes                             AS "keyframes"`;
}

/**
 * Joins every video row is read through: visible, non-rejected project links in the chosen
 * folders (`fo` is the project's folder).
 */
const VIDEO_FROM = `
  FROM asset_analyses aa
  JOIN assets asst ON asst.id = aa.asset_id
  JOIN project_media pm ON pm.asset_id = aa.asset_id AND pm.evaluation_status <> 'rejected'
  JOIN projects p ON p.id = pm.project_id AND p.folder_id = ANY(:scope_folder_ids)
  JOIN visible_projects vp ON vp.id = p.id
  LEFT JOIN folders fo ON fo.id = p.folder_id`;

@Injectable()
export class FootageService {
  constructor(
    private readonly scopeService: FootageScopeService,
    private readonly folderAccess: FolderAccessService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FolderEntity)
    private readonly folderRepo: Repository<FolderEntity>,
    @InjectRepository(AssetVariantEntity)
    private readonly variantRepo: Repository<AssetVariantEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(RenderProfileEntity)
    private readonly renderProfileRepo: Repository<RenderProfileEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly config: ConfigService,
    private readonly systemLog: SystemLogService,
    private readonly actorEnrichment: ActorEnrichmentService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /footage/folders
  // ---------------------------------------------------------------------------

  async getFolders(
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    folders: Array<{
      id: string;
      parentId: string | null;
      name: string;
      path: string;
      analyzedVideos: number;
      usableVideos: number;
    }>;
  }> {
    const folderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    if (folderIds.length === 0) return { folders: [] };

    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdminUserType(userType),
      folderIds,
      userId,
    );
    const countSql = `
      WITH ${cte}
      SELECT
        p.folder_id,
        COUNT(DISTINCT aa.asset_id) AS analyzed_count,
        COUNT(DISTINCT aa.asset_id) FILTER (WHERE aa.usable = true) AS usable_count
      FROM projects p
      JOIN visible_projects vp ON vp.id = p.id
      JOIN project_media pm ON pm.project_id = p.id AND pm.evaluation_status <> 'rejected'
      JOIN asset_analyses aa ON aa.asset_id = pm.asset_id AND aa.is_current = true
      WHERE p.folder_id = ANY(:folder_ids) AND aa.description IS NOT NULL
      GROUP BY p.folder_id
    `;
    const { sql, params: positional } = FootageScopeService.toPositional(countSql, {
      ...params,
      folder_ids: folderIds,
    });
    const countRows = (await this.dataSource.query(sql, positional)) as Array<{
      folder_id: string;
      analyzed_count: string;
      usable_count: string;
    }>;
    const countByFolder = new Map(
      countRows.map((r) => [
        r.folder_id,
        { analyzed: Number(r.analyzed_count), usable: Number(r.usable_count) },
      ]),
    );
    // Same order as the folder tree: parents first, then sort order and natural name per level.
    const folders = await this.folderRepo
      .createQueryBuilder('folder')
      .addSelect('folder.name COLLATE natural_sort', 'name_sort')
      .where('folder.id IN (:...ids)', { ids: folderIds })
      .andWhere('folder.isActive = true')
      .orderBy('folder.depth', 'ASC')
      .addOrderBy('folder.sortOrder', 'ASC')
      .addOrderBy('name_sort', 'ASC')
      .getMany();
    return {
      folders: folders.map((f) => ({
        id: f.id,
        parentId: f.parentId,
        name: f.name,
        path: f.pathText,
        analyzedVideos: countByFolder.get(f.id)?.analyzed ?? 0,
        usableVideos: countByFolder.get(f.id)?.usable ?? 0,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /footage/catalog
  // ---------------------------------------------------------------------------

  async getCatalog(
    body: FootageCatalogBodyDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{ items: FootageVideo[]; nextCursor: string | null }> {
    const { folderIds, cursor } = body;
    // Flat filters (current) win over the nested `filters` of older clients
    const filters = { ...(body.filters ?? {}), ...stripUndefined(body) };
    const limit = Math.min(body.limit ?? 200, 500);
    if (!folderIds || folderIds.length === 0 || folderIds.length > 50) {
      throw new BadRequestException('folderIds must have 1–50 entries');
    }

    const accessibleFolderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    await this.scopeService.assertFoldersInScope(folderIds, accessibleFolderIds);
    const scopeFolderIds = await this.scopeService.expandToAccessibleSubtree(
      folderIds,
      accessibleFolderIds,
    );
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdminUserType(userType),
      scopeFolderIds,
      userId,
    );
    const approvedExists = this.scopeService.approvedExistsClause('aa');
    const { offset } = decodeCursor(cursor);

    const where: string[] = ['aa.is_current = true', 'aa.description IS NOT NULL'];
    const queryParams: Record<string, unknown> = { ...params, scope_folder_ids: scopeFolderIds };
    if (filters.usableOnly !== false) where.push('aa.usable = true');
    if (filters.minQuality !== undefined) {
      where.push('aa.quality >= :min_quality');
      queryParams['min_quality'] = filters.minQuality;
    }
    if (filters.orientations?.length) {
      where.push('aa.orientation = ANY(:orientations)');
      queryParams['orientations'] = filters.orientations;
    }
    if (filters.q?.trim()) {
      where.push(textMatch());
      queryParams['search_q'] = filters.q.trim();
    }

    const sql = `
      WITH ${cte}
      SELECT ${videoSelect(approvedExists)}
      ${VIDEO_FROM}
      WHERE ${where.join(' AND ')}
      GROUP BY aa.id, asst.id
      ORDER BY aa.quality DESC NULLS LAST, aa.completed_at DESC NULLS LAST, aa.asset_id
      LIMIT :limit OFFSET :offset
    `;
    queryParams['limit'] = limit + 1;
    queryParams['offset'] = offset;
    const { sql: positionalSql, params: positional } = FootageScopeService.toPositional(
      sql,
      queryParams,
    );
    const rows = (await this.dataSource.query(positionalSql, positional)) as VideoRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: await Promise.all(page.map((row) => this.toVideo(row))),
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /footage/assets/:assetId/media
  // ---------------------------------------------------------------------------

  async getAssetMedia(
    assetId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    assetId: string;
    previewUrl: string | null;
    previewWidth: number | null;
    previewHeight: number | null;
    watermarked: boolean;
    /** Previews the player may choose from, smallest first (URLs via `.../preview-url`). */
    variants: PreviewDescription[];
    posterUrl: string | null;
    keyframes: { url: string; tMs: number }[];
    contactSheetUrl: string | null;
    durationMs: number | null;
    file: FootageFileInfo | null;
    projects: FootageProject[];
    expiresAt: string;
  }> {
    const folderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    await this.scopeService.assertAssetsInScope([assetId], { userId, userType, folderIds });
    const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const [asset, analysis, previews, projects] = await Promise.all([
      this.assetRepo.findOne({ where: { id: assetId } }),
      this.analysisRepo.findOne({ where: { assetId, isCurrent: true } }),
      this.servablePreviews(assetId),
      this.visibleProjectsOf(assetId, userId, userType, folderIds),
    ]);
    const preview = previews.at(-1) ?? null;

    let keyframes: { url: string; tMs: number }[] = [];
    let contactSheetUrl: string | null = null;
    if (asset && analysis) {
      const prefix = analysisPrefix(asset.originalStorageKey, asset.id, analysis.id);
      keyframes = await Promise.all(
        ((analysis.keyframes ?? []) as Array<{ output: string; t_ms: number }>).map(async (kf) => ({
          url: await this.storage.getPresignedGetUrl(`${prefix}${kf.output}`, 'image/jpeg', ttl),
          tMs: kf.t_ms,
        })),
      );
      const sheet = (analysis.artifacts as { contact_sheet?: { output: string } } | null)
        ?.contact_sheet;
      if (sheet) {
        contactSheetUrl = await this.storage.getPresignedGetUrl(
          `${prefix}${sheet.output}`,
          'image/jpeg',
          ttl,
        );
      }
    }
    const durationMs = analysis?.durationMs ?? durationFromMetadata(asset);
    // One account lookup for the uploader and every project owner.
    const users = await this.usersById([
      ...(asset ? [asset.createdBy] : []),
      ...projects.map((project) => project.ownerUserId),
    ]);
    return {
      assetId,
      previewUrl: preview
        ? await this.storage.getPresignedGetUrl(preview.storageKey, preview.mimeType, ttl)
        : null,
      previewWidth: preview?.width ?? null,
      previewHeight: preview?.height ?? null,
      watermarked: preview?.hasWatermark ?? false,
      variants: previews.map((variant) =>
        describePreview(variant, durationMs !== null ? durationMs / 1000 : null),
      ),
      posterUrl: keyframes[0]?.url ?? null,
      keyframes,
      contactSheetUrl,
      durationMs,
      file: asset
        ? fileInfo(asset, analysis, durationMs, users.get(asset.createdBy) ?? null)
        : null,
      projects: projects.map((project) => ({
        ...project,
        ownerUser: users.get(project.ownerUserId) ?? null,
      })),
      expiresAt,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /footage/assets/:assetId/preview-url
  // ---------------------------------------------------------------------------

  /** Presigned URL of one preview the footage player offers (same watermark policy as `media`). */
  async getPreviewUrl(
    assetId: string,
    variantCode: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    url: string;
    expiresAt: string;
    variantCode: string;
    mimeType: string;
    width: number | null;
    height: number | null;
  }> {
    await this.scopeService.assertAssetsInScope([assetId], { userId, userType });
    const variant = (await this.servablePreviews(assetId)).find(
      (candidate) => candidate.variantCode === variantCode,
    );
    if (!variant) {
      throw new NotFoundException(`Preview not found: ${variantCode}`);
    }
    const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;
    return {
      url: await this.storage.getPresignedGetUrl(variant.storageKey, variant.mimeType, ttl),
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      variantCode: variant.variantCode,
      mimeType: variant.mimeType,
      width: variant.width,
      height: variant.height,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /footage/assets/resolve
  // ---------------------------------------------------------------------------

  /**
   * Signed URLs of whole video files for rendering (decision 8): users who may see originals get the
   * original for a final render and the analysis proxy for a preview; everyone else gets the widest
   * servable preview variant.
   */
  async resolveAssets(
    assetIds: string[],
    purpose: ResolvePurpose,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    userPermissions?: string[],
    requestId?: string,
  ): Promise<ResolveAssetsResponse> {
    const uniqueIds = [...new Set(assetIds)];
    await this.scopeService.assertAssetsInScope(uniqueIds, { userId, userType });

    const canAccessOriginal =
      isAdminUserType(userType) ||
      userPermissions?.includes(GO_PERMISSIONS.PROJECT_EVALUATE) ||
      userPermissions?.includes(GO_PERMISSIONS.PROJECT_DOWNLOAD_ORIGINAL);
    const ttl = this.config.get<number>('FARM_URL_TTL_SECONDS') ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const [assets, analyses] = await Promise.all([
      this.assetRepo.find({ where: { id: In(uniqueIds) } }),
      this.analysisRepo.find({ where: { assetId: In(uniqueIds), isCurrent: true } }),
    ]);
    const analysisByAsset = new Map(analyses.map((a) => [a.assetId, a]));
    const items: ResolvedAssetItem[] = [];
    const missing: string[] = [];

    for (const asset of assets) {
      const analysis = analysisByAsset.get(asset.id) ?? null;
      const durationMs = analysis?.durationMs ?? durationFromMetadata(asset);
      const original = async (): Promise<ResolvedAssetItem> => ({
        assetId: asset.id,
        url: await this.storage.getPresignedGetUrl(asset.originalStorageKey, asset.mimeType, ttl),
        sourceKind: 'original',
        watermarked: false,
        contentType: asset.mimeType,
        sizeBytes: Number(asset.fileSizeBytes) || null,
        durationMs,
        cacheKey: `original:${asset.id}`,
        expiresAt,
      });

      if (canAccessOriginal) {
        if (purpose === 'final' || !analysis) {
          items.push(await original());
          continue;
        }
        const proxyKey = `${analysisPrefix(asset.originalStorageKey, asset.id, analysis.id)}proxy.mp4`;
        const head = await this.storage.headObject(proxyKey).catch(() => null);
        if (!head) {
          items.push(await original());
          continue;
        }
        items.push({
          assetId: asset.id,
          url: await this.storage.getPresignedGetUrl(proxyKey, 'video/mp4', ttl),
          sourceKind: 'proxy',
          watermarked: false,
          contentType: 'video/mp4',
          sizeBytes: head.sizeBytes,
          durationMs,
          cacheKey: `proxy:${analysis.id}`,
          expiresAt,
        });
        continue;
      }

      const preview = await this.bestPreview(asset.id);
      if (!preview) {
        missing.push(asset.id);
        continue;
      }
      items.push({
        assetId: asset.id,
        url: await this.storage.getPresignedGetUrl(preview.storageKey, preview.mimeType, ttl),
        sourceKind: 'preview',
        watermarked: preview.hasWatermark,
        contentType: preview.mimeType,
        sizeBytes: Number(preview.fileSizeBytes) || null,
        durationMs,
        cacheKey: `variant:${preview.id}`,
        expiresAt,
      });
    }

    try {
      await this.systemLog.write({
        level: 'info',
        category: 'footage',
        action: 'resolve',
        message: `Resolved ${items.length} videos for userId=${userId} purpose=${purpose}`,
        requestId,
        userId,
        metadata: { videoCount: items.length, missing: missing.length, purpose, canAccessOriginal },
      });
    } catch {
      // Audit failure must not block the response
    }
    return { items, missing };
  }

  // ---------------------------------------------------------------------------
  // GET /footage/search
  // ---------------------------------------------------------------------------

  async search(
    query: FootageSearchQueryDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    items: Array<FootageVideo & { score: number }>;
    nextCursor: string | null;
    total: number;
  }> {
    const limit = Math.min(query.limit ?? 40, 100);
    const offset = query.page ? (query.page - 1) * limit : decodeCursor(query.cursor).offset;
    const scope = await this.resolveScope(query.folderIds, userId, userType);
    if (!scope) return { items: [], nextCursor: null, total: 0 };
    const { cte, params } = scope;
    const queryParams: Record<string, unknown> = { ...params };
    const where = filterClauses(query, queryParams);
    const approvedExists = this.scopeService.approvedExistsClause('aa');

    let scoreExpr = `(COALESCE(aa.quality, 0) * 0.1 + CASE WHEN (${approvedExists}) THEN 0.05 ELSE 0.0 END)`;
    if (query.q?.trim()) {
      scoreExpr = `(
        COALESCE(ts_rank(aa.search_vector, websearch_to_tsquery('simple', immutable_unaccent(:search_q))), 0.0)
        + similarity(coalesce(aa.description ->> 'title_vi', ''), :search_q) * 0.2
        + similarity(coalesce(aa.description ->> 'summary_en', ''), :search_q) * 0.05
        + COALESCE(aa.quality, 0) * 0.1
        + CASE WHEN (${approvedExists}) THEN 0.05 ELSE 0.0 END
      )`;
    }

    const sql = `
      WITH ${cte}
      SELECT ${videoSelect(approvedExists)}, ${scoreExpr} AS score
      ${VIDEO_FROM}
      WHERE ${where.join(' AND ')}
      GROUP BY aa.id, asst.id
      ORDER BY ${orderByClause(query.sortBy, query.sortOrder)}
      LIMIT :limit OFFSET :offset
    `;
    const countSql = `
      WITH ${cte}
      SELECT COUNT(DISTINCT aa.id) AS total
      ${VIDEO_FROM}
      WHERE ${where.join(' AND ')}
    `;
    const [rows, countRows] = await Promise.all([
      this.query<VideoRow & { score: number }>(sql, { ...queryParams, limit: limit + 1, offset }),
      this.query<{ total: string }>(countSql, queryParams),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: await Promise.all(
        page.map(async (row) => ({ ...(await this.toVideo(row)), score: Number(row.score) })),
      ),
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /footage/facets
  // ---------------------------------------------------------------------------

  /**
   * Counts of each filter value among the videos the other filters match: a facet leaves its own
   * filter out, so picking a value does not hide the other values of the same filter.
   */
  async getFacets(
    query: FootageFilters,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    tags: FacetValue[];
    genres: FacetValue[];
    timesOfDay: FacetValue[];
    orientations: FacetValue[];
    resolutions: FacetValue[];
    categories: FacetValue[];
    provinces: FacetValue[];
    projects: FacetValue[];
    authors: FacetValue[];
  }> {
    const empty = {
      tags: [],
      genres: [],
      timesOfDay: [],
      orientations: [],
      resolutions: [],
      categories: [],
      provinces: [],
      projects: [],
      authors: [],
    };
    const scope = await this.resolveScope(query.folderIds, userId, userType);
    if (!scope) return empty;
    const { cte, params } = scope;
    const facet = async (
      own: keyof FootageFilters,
      valueExpr: string,
      extraWhere: string,
      limit = 30,
    ): Promise<Array<{ value: string; count: string }>> => {
      const queryParams: Record<string, unknown> = { ...params, facet_limit: limit };
      const where = filterClauses({ ...query, [own]: undefined }, queryParams);
      const sql = `
        WITH ${cte}
        SELECT ${valueExpr} AS value, COUNT(DISTINCT aa.asset_id) AS count
        ${VIDEO_FROM}
        WHERE ${where.join(' AND ')} AND ${extraWhere}
        GROUP BY 1 ORDER BY count DESC, 1 LIMIT :facet_limit
      `;
      return this.query<{ value: string; count: string }>(sql, queryParams);
    };
    const [
      tags,
      genres,
      timesOfDay,
      orientations,
      resolutions,
      categories,
      provinces,
      projects,
      authors,
    ] = await Promise.all([
      facet(
        'tags',
        `jsonb_array_elements_text(aa.description -> 'tags')`,
        `jsonb_typeof(aa.description -> 'tags') = 'array'`,
        100,
      ),
      facet(
        'genres',
        `aa.description ->> 'genre'`,
        `coalesce(aa.description ->> 'genre', '') <> ''`,
      ),
      facet('timesOfDay', `aa.description ->> 'time_of_day'`, `aa.description ? 'time_of_day'`),
      facet('orientations', 'aa.orientation', 'aa.orientation IS NOT NULL'),
      facet('resolutions', RESOLUTION_CLASS_SQL, `${SHORT_EDGE_SQL} IS NOT NULL`),
      facet('categoryIds', 'CAST(p.category_id AS text)', 'p.category_id IS NOT NULL', 200),
      facet('provinceIds', 'CAST(p.province_id AS text)', 'p.province_id IS NOT NULL', 200),
      facet('projectIds', 'CAST(p.id AS text)', 'TRUE', 500),
      facet('ownerUserIds', 'p.owner_user_id', 'TRUE', 200),
    ]);
    const names = async (table: 'categories' | 'provinces' | 'projects', ids: string[]) =>
      ids.length
        ? new Map(
            (
              await this.query<{ id: string; name: string }>(
                `SELECT CAST(id AS text) AS id, name FROM ${table} WHERE CAST(id AS text) = ANY(:ids)`,
                { ids },
              )
            ).map((r) => [r.id, r.name]),
          )
        : new Map<string, string>();
    const [categoryNames, provinceNames, projectNames, authorNames] = await Promise.all([
      names(
        'categories',
        categories.map((r) => r.value),
      ),
      names(
        'provinces',
        provinces.map((r) => r.value),
      ),
      names(
        'projects',
        projects.map((r) => r.value),
      ),
      this.userNames(authors.map((r) => r.value)),
    ]);
    const plain = (rows: Array<{ value: string; count: string }>): FacetValue[] =>
      rows.map((r) => ({ value: r.value, count: Number(r.count) }));
    const labelled = (
      rows: Array<{ value: string; count: string }>,
      map: Map<string, string>,
    ): FacetValue[] =>
      rows.map((r) => ({
        value: r.value,
        label: map.get(r.value) ?? r.value,
        count: Number(r.count),
      }));
    return {
      tags: plain(tags),
      genres: plain(genres),
      timesOfDay: plain(timesOfDay),
      orientations: plain(orientations),
      resolutions: plain(resolutions),
      categories: labelled(categories, categoryNames),
      provinces: labelled(provinces, provinceNames),
      projects: labelled(projects, projectNames),
      authors: labelled(authors, authorNames),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Visible-projects CTE over the folders searched; null when the user can see no folder. */
  private async resolveScope(
    folderIds: string[] | undefined,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{ cte: string; params: Record<string, unknown> } | null> {
    const accessibleFolderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    const scopeFolderIds = folderIds?.length
      ? await this.scopeService.expandToAccessibleSubtree(folderIds, accessibleFolderIds)
      : accessibleFolderIds;
    if (scopeFolderIds.length === 0) return null;
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdminUserType(userType),
      scopeFolderIds,
      userId,
    );
    return { cte, params: { ...params, scope_folder_ids: scopeFolderIds } };
  }

  /** Runs SQL with `:named` parameters. */
  private async query<T>(sql: string, named: Record<string, unknown>): Promise<T[]> {
    const { sql: positionalSql, params } = FootageScopeService.toPositional(sql, named);
    return (await this.dataSource.query(positionalSql, params)) as T[];
  }

  /** Account users by id; unknown ids (or an unreachable account service) are left out. */
  private async usersById(userIds: string[]): Promise<Map<string, ActorUser>> {
    const rows = (await this.actorEnrichment.enrich(
      [...new Set(userIds)].map((id) => ({ id })),
      [{ id: 'id', target: 'user' }],
    )) as Array<{ id: string; user?: ActorUser | null }>;
    return new Map(rows.flatMap((row) => (row.user ? [[row.id, row.user] as const] : [])));
  }

  /** Display name of each user (name, else email), for labelling authors. */
  private async userNames(userIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const [id, user] of await this.usersById(userIds)) {
      const label = actorLabel(user);
      if (label) names.set(id, label);
    }
    return names;
  }

  /**
   * Projects the video is linked to that the user can see (not where it was rejected); the
   * caller fills in `ownerUser`.
   */
  private async visibleProjectsOf(
    assetId: string,
    userId: string,
    userType: 'ADMIN' | 'USER' | undefined,
    folderIds: string[],
  ): Promise<FootageProject[]> {
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdminUserType(userType),
      folderIds,
      userId,
    );
    const rows = await this.query<ProjectRow>(
      `
      WITH ${cte}
      SELECT
        p.id,
        p.name,
        p.description,
        p.evaluation_status AS "evaluationStatus",
        pm.evaluation_status AS "mediaEvaluationStatus",
        p.folder_id AS "folderId",
        f.path_text AS "folderPath",
        c.name AS "categoryName",
        co.name AS "countryName",
        pr.name AS "provinceName",
        (
          SELECT array_agg(t.name ORDER BY t.normalized_name)
          FROM project_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.project_id = p.id
        ) AS "tags",
        p.owner_user_id AS "ownerUserId",
        p.created_at AS "createdAt",
        p.updated_at AS "updatedAt"
      FROM project_media pm
      JOIN projects p ON p.id = pm.project_id
      JOIN visible_projects vp ON vp.id = p.id
      LEFT JOIN folders f ON f.id = p.folder_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN countries co ON co.id = p.country_id
      LEFT JOIN provinces pr ON pr.id = p.province_id
      WHERE pm.asset_id = :asset_id AND pm.evaluation_status <> 'rejected'
      ORDER BY p.name COLLATE natural_sort, p.id
      `,
      { ...params, asset_id: assetId },
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      evaluationStatus: row.evaluationStatus,
      mediaEvaluationStatus: row.mediaEvaluationStatus,
      folderId: row.folderId,
      folderPath: row.folderPath ?? '',
      categoryName: row.categoryName,
      countryName: row.countryName,
      provinceName: row.provinceName,
      tags: row.tags ?? [],
      ownerUserId: row.ownerUserId,
      ownerUser: null,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }

  private async toVideo(row: VideoRow): Promise<FootageVideo> {
    const firstKeyframe = Array.isArray(row.keyframes) ? row.keyframes[0]?.output : undefined;
    let thumbnailUrl: string | null = null;
    if (firstKeyframe) {
      const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;
      thumbnailUrl = await this.storage
        .getPresignedGetUrl(
          `${analysisPrefix(row.storageKey, row.assetId, row.analysisId)}${firstKeyframe}`,
          'image/jpeg',
          ttl,
        )
        .catch(() => null);
    }
    return {
      ...descriptionView(row.description),
      assetId: row.assetId,
      name: row.name,
      projectIds: row.projectIds ?? [],
      projectNames: row.projectNames ?? [],
      // One per project, so a folder holding two of them shows up twice.
      folderIds: [...new Set(row.folderIds ?? [])],
      durationMs: row.durationMs ?? 0,
      width: row.width ?? 0,
      height: row.height ?? 0,
      orientation: row.orientation ?? 'landscape',
      hasAudio: row.hasAudio ?? false,
      hasSpeech: row.hasSpeech,
      approved: Boolean(row.approved),
      analyzedAt: row.analyzedAt ? new Date(row.analyzedAt).toISOString() : '',
      thumbnailUrl,
    };
  }

  /** Ready previews the active render profile lets everyone see, smallest first. */
  private async servablePreviews(assetId: string): Promise<AssetVariantEntity[]> {
    const [variants, profile] = await Promise.all([
      this.variantRepo.find({ where: { assetId, status: 'ready' } }),
      findActiveRenderProfile(this.renderProfileRepo),
    ]);
    return variants
      .filter((v) => isPreviewVariantCode(v.variantCode) && isVariantServable(v, profile))
      .sort(comparePreviews);
  }

  /** Widest ready preview variant the active render profile lets everyone see. */
  private async bestPreview(assetId: string): Promise<AssetVariantEntity | null> {
    return (await this.servablePreviews(assetId)).at(-1) ?? null;
  }
}

type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  evaluationStatus: string;
  mediaEvaluationStatus: string;
  folderId: string;
  folderPath: string | null;
  categoryName: string | null;
  countryName: string | null;
  provinceName: string | null;
  tags: string[] | null;
  ownerUserId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** WHERE clauses (and their parameters) of the search filters, over `aa`, `asst`, `p`. */
function filterClauses(query: FootageFilters, queryParams: Record<string, unknown>): string[] {
  const where: string[] = ['aa.is_current = true', 'aa.description IS NOT NULL'];
  const usability = query.usability ?? (query.usableOnly === false ? 'all' : 'usable');
  if (usability === 'usable') where.push('aa.usable = true');
  else if (usability === 'unusable') where.push('aa.usable IS NOT TRUE');
  if (query.q?.trim()) {
    where.push(textMatch());
    queryParams['search_q'] = query.q.trim();
  }
  if (query.orientations?.length) {
    where.push('aa.orientation = ANY(:orientations)');
    queryParams['orientations'] = query.orientations;
  }
  if (query.resolutions?.length) {
    where.push(`(${RESOLUTION_CLASS_SQL}) = ANY(:resolutions)`);
    queryParams['resolutions'] = query.resolutions;
  }
  if (query.timesOfDay?.length) {
    where.push(`(aa.description ->> 'time_of_day') = ANY(:times_of_day)`);
    queryParams['times_of_day'] = query.timesOfDay;
  }
  if (query.genres?.length) {
    where.push(`(aa.description ->> 'genre') = ANY(:genres)`);
    queryParams['genres'] = query.genres;
  }
  if (query.tags?.length) {
    where.push(`(aa.description -> 'tags') ?| :filter_tags`);
    queryParams['filter_tags'] = query.tags;
  }
  if (query.minDurationMs !== undefined) {
    where.push('aa.duration_ms >= :min_dur');
    queryParams['min_dur'] = query.minDurationMs;
  }
  if (query.maxDurationMs !== undefined) {
    where.push('aa.duration_ms <= :max_dur');
    queryParams['max_dur'] = query.maxDurationMs;
  }
  if (query.categoryIds?.length) {
    where.push('p.category_id = ANY(:category_ids)');
    queryParams['category_ids'] = query.categoryIds;
  }
  if (query.provinceIds?.length) {
    where.push('p.province_id = ANY(:province_ids)');
    queryParams['province_ids'] = query.provinceIds;
  }
  if (query.projectIds?.length) {
    where.push('p.id = ANY(:project_ids)');
    queryParams['project_ids'] = query.projectIds;
  }
  if (query.ownerUserIds?.length) {
    where.push('p.owner_user_id = ANY(:owner_user_ids)');
    queryParams['owner_user_ids'] = query.ownerUserIds;
  }
  return where;
}

/** Sort fields that read best A → Z when no order is given. */
const ASCENDING_BY_DEFAULT: FootageSortField[] = ['name', 'folder', 'project'];

/**
 * ORDER BY of a grouped search page (needs the `score` column); ties go by score, then a stable
 * id. A video in several visible projects sorts by one of them: for `folder` the first by
 * folder path then name (both keys from that same project, as the project list sorts by
 * folder), for `project` the first by name.
 */
function orderByClause(sortBy: FootageSortField = 'relevance', sortOrder?: FootageSortOrder) {
  const order = sortOrder ?? (ASCENDING_BY_DEFAULT.includes(sortBy) ? 'asc' : 'desc');
  const firstProject = (column: string) =>
    `(array_agg(${column} ORDER BY ${PROJECT_ORDER_SQL}))[1] COLLATE natural_sort`;
  const keys: Record<FootageSortField, string[]> = {
    relevance: ['score'],
    analyzedAt: ['aa.completed_at'],
    quality: ['aa.quality'],
    duration: ['aa.duration_ms'],
    resolution: [SHORT_EDGE_SQL],
    name: ['asst.original_filename COLLATE natural_sort'],
    folder: [firstProject('fo.path_text'), firstProject('p.name')],
    project: ['MIN(p.name COLLATE natural_sort)'],
  };
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  return [
    ...keys[sortBy].map((key) => `${key} ${direction} NULLS LAST`),
    'score DESC',
    'aa.asset_id',
  ].join(', ');
}

/** Metadata of the original file: probed when processed, completed by the analysis. */
function fileInfo(
  asset: AssetEntity,
  analysis: AssetAnalysisEntity | null,
  durationMs: number | null,
  uploader: ActorUser | null,
): FootageFileInfo {
  const source = asset.sourceMetadata ?? {};
  const media = (analysis?.artifacts as { media?: Record<string, unknown> } | null)?.media ?? {};
  const bytes = Number(asset.fileSizeBytes);
  const models = analysis?.models ?? {};
  return {
    filename: asset.originalFilename,
    extension: asset.extension,
    mimeType: asset.mimeType,
    fileSizeBytes: asset.fileSizeBytes,
    width: finiteNumber(source['width']) ?? finiteNumber(media['width']),
    height: finiteNumber(source['height']) ?? finiteNumber(media['height']),
    durationMs,
    frameRate: finiteNumber(source['frameRate']) ?? finiteNumber(media['fps']),
    codec: nonEmptyString(source['codec']),
    format: nonEmptyString(source['format']),
    bitrateBps:
      bytes > 0 && durationMs && durationMs > 0
        ? Math.round((bytes * 8) / (durationMs / 1000))
        : null,
    hasAudio: analysis?.hasAudio ?? null,
    sourceType: asset.sourceType,
    uploadedAt: new Date(asset.createdAt).toISOString(),
    uploadedBy: asset.createdBy,
    uploadedByUser: uploader,
    analyzedAt: analysis?.completedAt ? new Date(analysis.completedAt).toISOString() : null,
    analysisModel: nonEmptyString(models['ai']) ?? nonEmptyString(models['model']),
  };
}

function actorLabel(user: ActorUser | null | undefined): string | null {
  if (!user) return null;
  if (typeof user.name === 'string' && user.name.trim()) return user.name.trim();
  return typeof user.email === 'string' && user.email ? user.email : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Full-text on the search vector, trigram closeness to the title, or a part of the file name
 * (all accent-insensitive).
 */
function textMatch(): string {
  return `(aa.search_vector @@ websearch_to_tsquery('simple', immutable_unaccent(:search_q))
    OR similarity(immutable_unaccent(lower(coalesce(aa.description ->> 'title_vi', ''))), immutable_unaccent(lower(:search_q))) > 0.15
    OR strpos(immutable_unaccent(lower(asst.original_filename)), immutable_unaccent(lower(:search_q))) > 0)`;
}

function analysisPrefix(originalStorageKey: string, assetId: string, analysisId: string): string {
  return `${assetVariantsPrefix(originalStorageKey, assetId)}analysis/${analysisId}/`;
}

function durationFromMetadata(asset: AssetEntity | null): number | null {
  const seconds = (asset?.sourceMetadata as { durationSeconds?: unknown } | null)?.durationSeconds;
  return typeof seconds === 'number' ? Math.round(seconds * 1000) : null;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
