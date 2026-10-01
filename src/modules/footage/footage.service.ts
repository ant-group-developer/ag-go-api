import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
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
import { isPreviewVariantCode } from '../render/render-sizes';
import { findActiveRenderProfile, isVariantServable } from '../render/watermark-policy';
import type { FootageCatalogBodyDto } from './dto/catalog-query.dto';
import type {
  ResolveAssetsResponse,
  ResolvePurpose,
  ResolvedAssetItem,
} from './dto/resolve-assets.dto';
import type { FootageSearchQueryDto } from './dto/search-query.dto';
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

/** Columns of a FootageVideo row; needs `aa` (current asset_analyses), `asst` (assets), `p`, `pm`, `visible_projects`. */
function videoSelect(approvedExists: string): string {
  return `
    aa.asset_id                              AS "assetId",
    aa.id                                    AS "analysisId",
    asst.original_filename                   AS "name",
    asst.original_storage_key                AS "storageKey",
    array_agg(DISTINCT p.id)                 AS "projectIds",
    array_agg(DISTINCT p.name)               AS "projectNames",
    array_agg(DISTINCT p.folder_id)          AS "folderIds",
    aa.duration_ms                           AS "durationMs",
    CAST(aa.artifacts -> 'media' ->> 'width' AS int)  AS "width",
    CAST(aa.artifacts -> 'media' ->> 'height' AS int) AS "height",
    aa.orientation                           AS "orientation",
    aa.has_audio                             AS "hasAudio",
    aa.has_speech                            AS "hasSpeech",
    aa.description                           AS "description",
    (${approvedExists})                      AS "approved",
    aa.completed_at                          AS "analyzedAt",
    aa.keyframes                             AS "keyframes"`;
}

/** Joins every video row is read through: visible, non-rejected project links in the chosen folders. */
const VIDEO_FROM = `
  FROM asset_analyses aa
  JOIN assets asst ON asst.id = aa.asset_id
  JOIN project_media pm ON pm.asset_id = aa.asset_id AND pm.evaluation_status <> 'rejected'
  JOIN projects p ON p.id = pm.project_id AND p.folder_id = ANY(:scope_folder_ids)
  JOIN visible_projects vp ON vp.id = p.id`;

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
    const folders = await this.folderRepo.find({
      where: { id: In(folderIds) },
      order: { pathText: 'ASC' },
    });
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
    posterUrl: string | null;
    keyframes: { url: string; tMs: number }[];
    contactSheetUrl: string | null;
    durationMs: number | null;
    expiresAt: string;
  }> {
    await this.scopeService.assertAssetsInScope([assetId], { userId, userType });
    const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const [asset, analysis, preview] = await Promise.all([
      this.assetRepo.findOne({ where: { id: assetId } }),
      this.analysisRepo.findOne({ where: { assetId, isCurrent: true } }),
      this.bestPreview(assetId),
    ]);

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
    return {
      assetId,
      previewUrl: preview
        ? await this.storage.getPresignedGetUrl(preview.storageKey, preview.mimeType, ttl)
        : null,
      previewWidth: preview?.width ?? null,
      previewHeight: preview?.height ?? null,
      watermarked: preview?.hasWatermark ?? false,
      posterUrl: keyframes[0]?.url ?? null,
      keyframes,
      contactSheetUrl,
      durationMs: analysis?.durationMs ?? durationFromMetadata(asset),
      expiresAt,
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
  ): Promise<{ items: Array<FootageVideo & { score: number }>; nextCursor: string | null }> {
    const limit = Math.min(query.limit ?? 40, 100);
    const { offset } = decodeCursor(query.cursor);
    const scope = await this.searchScope(query, userId, userType);
    if (!scope) return { items: [], nextCursor: null };
    const { cte, where, queryParams } = scope;
    const approvedExists = this.scopeService.approvedExistsClause('aa');

    let scoreExpr = `(COALESCE(aa.quality, 0) * 0.1 + CASE WHEN (${approvedExists}) THEN 0.05 ELSE 0.0 END)`;
    if (query.q?.trim()) {
      queryParams['search_q'] = query.q.trim();
      where.push(textMatch());
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
      ORDER BY score DESC, aa.asset_id
      LIMIT :limit OFFSET :offset
    `;
    queryParams['limit'] = limit + 1;
    queryParams['offset'] = offset;
    const { sql: positionalSql, params: positional } = FootageScopeService.toPositional(
      sql,
      queryParams,
    );
    const rows = (await this.dataSource.query(positionalSql, positional)) as Array<
      VideoRow & { score: number }
    >;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: await Promise.all(
        page.map(async (row) => ({ ...(await this.toVideo(row)), score: Number(row.score) })),
      ),
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /footage/facets
  // ---------------------------------------------------------------------------

  async getFacets(
    query: Omit<FootageSearchQueryDto, 'limit' | 'cursor'>,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    tags: FacetValue[];
    genres: FacetValue[];
    timesOfDay: FacetValue[];
    orientations: FacetValue[];
    categories: FacetValue[];
    provinces: FacetValue[];
  }> {
    const empty = {
      tags: [],
      genres: [],
      timesOfDay: [],
      orientations: [],
      categories: [],
      provinces: [],
    };
    const scope = await this.searchScope(query, userId, userType);
    if (!scope) return empty;
    const { cte, where, queryParams } = scope;
    if (query.q?.trim()) {
      queryParams['search_q'] = query.q.trim();
      where.push(textMatch());
    }
    const whereStr = where.join(' AND ');
    const facet = async (
      valueExpr: string,
      extraWhere: string,
    ): Promise<Array<{ value: string; count: string }>> => {
      const sql = `
        WITH ${cte}
        SELECT ${valueExpr} AS value, COUNT(DISTINCT aa.asset_id) AS count
        ${VIDEO_FROM}
        WHERE ${whereStr} AND ${extraWhere}
        GROUP BY 1 ORDER BY count DESC LIMIT 30
      `;
      const { sql: positionalSql, params: positional } = FootageScopeService.toPositional(
        sql,
        queryParams,
      );
      return (await this.dataSource.query(positionalSql, positional)) as Array<{
        value: string;
        count: string;
      }>;
    };
    const [tags, genres, timesOfDay, orientations, categories, provinces] = await Promise.all([
      facet(
        `jsonb_array_elements_text(aa.description -> 'tags')`,
        `jsonb_typeof(aa.description -> 'tags') = 'array'`,
      ),
      facet(`aa.description ->> 'genre'`, `coalesce(aa.description ->> 'genre', '') <> ''`),
      facet(`aa.description ->> 'time_of_day'`, `aa.description ? 'time_of_day'`),
      facet('aa.orientation', 'aa.orientation IS NOT NULL'),
      facet('CAST(p.category_id AS text)', 'p.category_id IS NOT NULL'),
      facet('CAST(p.province_id AS text)', 'p.province_id IS NOT NULL'),
    ]);
    const names = async (table: 'categories' | 'provinces', ids: string[]) =>
      ids.length
        ? new Map(
            (
              (await this.dataSource.query(
                `SELECT id::text AS id, name FROM ${table} WHERE id::text = ANY($1)`,
                [ids],
              )) as Array<{ id: string; name: string }>
            ).map((r) => [r.id, r.name]),
          )
        : new Map<string, string>();
    const [categoryNames, provinceNames] = await Promise.all([
      names(
        'categories',
        categories.map((r) => r.value),
      ),
      names(
        'provinces',
        provinces.map((r) => r.value),
      ),
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
      categories: labelled(categories, categoryNames),
      provinces: labelled(provinces, provinceNames),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Scope CTE and filters shared by search and facets; null when the user can see no folder. */
  private async searchScope(
    query: Omit<FootageSearchQueryDto, 'limit' | 'cursor'>,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{ cte: string; where: string[]; queryParams: Record<string, unknown> } | null> {
    const accessibleFolderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    const scopeFolderIds = query.folderIds?.length
      ? await this.scopeService.expandToAccessibleSubtree(query.folderIds, accessibleFolderIds)
      : accessibleFolderIds;
    if (scopeFolderIds.length === 0) return null;
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdminUserType(userType),
      scopeFolderIds,
      userId,
    );
    const where: string[] = ['aa.is_current = true', 'aa.description IS NOT NULL'];
    const queryParams: Record<string, unknown> = { ...params, scope_folder_ids: scopeFolderIds };
    if (query.usableOnly !== false) where.push('aa.usable = true');
    if (query.orientations?.length) {
      where.push('aa.orientation = ANY(:orientations)');
      queryParams['orientations'] = query.orientations;
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
    return { cte, where, queryParams };
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
      folderIds: row.folderIds ?? [],
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

  /** Widest ready preview variant the active render profile lets everyone see. */
  private async bestPreview(assetId: string): Promise<AssetVariantEntity | null> {
    const [variants, profile] = await Promise.all([
      this.variantRepo.find({ where: { assetId, status: 'ready' } }),
      findActiveRenderProfile(this.renderProfileRepo),
    ]);
    const previews = variants
      .filter((v) => isPreviewVariantCode(v.variantCode) && isVariantServable(v, profile))
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    return previews[0] ?? null;
  }
}

/** Full-text on the search vector, or trigram closeness to the title (accent-insensitive). */
function textMatch(): string {
  return `(aa.search_vector @@ websearch_to_tsquery('simple', immutable_unaccent(:search_q))
    OR similarity(immutable_unaccent(lower(coalesce(aa.description ->> 'title_vi', ''))), immutable_unaccent(lower(:search_q))) > 0.15)`;
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
