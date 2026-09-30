import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { isAdminUserType } from '../../common/auth/user-type';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { MediaSegmentEntity } from '../../database/entities/media-segment.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { FolderAccessService } from '../folders/folder-access.service';
import { SystemLogService } from '../logs/system-log.service';
import { assetVariantsPrefix } from '../projects/project-asset-cleanup';
import { isPreviewVariantCode } from '../render/render-sizes';
import { findActiveRenderProfile, isVariantServable } from '../render/watermark-policy';
import type { FootageCatalogBodyDto } from './dto/catalog-query.dto';
import type { ResolvePurpose, ResolvedSegmentItem } from './dto/resolve-segments.dto';
import type { FootageSearchQueryDto } from './dto/search-query.dto';
import { FootageScopeService } from './footage-scope.service';

/** CatalogItem shape returned by /footage/catalog and /footage/search */
export type CatalogItem = {
  segmentId: string;
  assetId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  captionVi: string | null;
  captionEn: string | null;
  tags: string[] | null;
  keywordsVi: string[] | null;
  subjects: string[] | null;
  actions: string[] | null;
  shotSize: string | null;
  cameraMotion: string | null;
  timeOfDay: string | null;
  setting: string | null;
  peopleCount: string | null;
  orientation: string | null;
  quality: number | null;
  usable: boolean | null;
  approved: boolean;
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

@Injectable()
export class FootageService {
  constructor(
    private readonly scopeService: FootageScopeService,
    private readonly folderAccess: FolderAccessService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(FolderEntity)
    private readonly folderRepo: Repository<FolderEntity>,
    @InjectRepository(MediaSegmentEntity)
    private readonly segmentRepo: Repository<MediaSegmentEntity>,
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
      analyzedSegments: number;
      usableSegments: number;
    }>;
  }> {
    const folderIds = await this.folderAccess.accessibleFolderIds(userId, userType);

    if (folderIds.length === 0) {
      return { folders: [] };
    }

    const isAdmin = isAdminUserType(userType);
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(isAdmin, folderIds, userId);
    const visibleExists = this.scopeService.visibleExistsClause('s');

    // Count analyzed and usable segments per folder
    const countSql = `
      WITH ${cte}
      SELECT
        p.folder_id,
        COUNT(DISTINCT s.id) FILTER (WHERE s.is_current = true AND ${visibleExists}) AS analyzed_count,
        COUNT(DISTINCT s.id) FILTER (WHERE s.is_current = true AND s.usable = true AND ${visibleExists}) AS usable_count
      FROM projects p
      JOIN project_media pm ON pm.project_id = p.id AND pm.evaluation_status <> 'rejected'
      JOIN media_segments s ON s.asset_id = pm.asset_id AND s.is_current = true
      WHERE p.folder_id = ANY(:folder_ids)
      GROUP BY p.folder_id
    `;

    const { sql: countSqlPos, params: countParamsPos } = FootageScopeService.toPositional(
      countSql,
      { ...params, folder_ids: folderIds },
    );
    const countRows = (await this.dataSource.query(countSqlPos, countParamsPos)) as Array<{
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
        analyzedSegments: countByFolder.get(f.id)?.analyzed ?? 0,
        usableSegments: countByFolder.get(f.id)?.usable ?? 0,
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
  ): Promise<{ items: CatalogItem[]; nextCursor: string | null }> {
    const { folderIds, filters, cursor } = body;
    const limit = Math.min(body.limit ?? 500, 1000);

    if (!folderIds || folderIds.length === 0 || folderIds.length > 50) {
      throw new BadRequestException('folderIds must have 1–50 entries');
    }

    const accessibleFolderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    await this.scopeService.assertFoldersInScope(folderIds, accessibleFolderIds);
    const scopeFolderIds = await this.scopeService.expandToAccessibleSubtree(
      folderIds,
      accessibleFolderIds,
    );

    const isAdmin = isAdminUserType(userType);
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdmin,
      scopeFolderIds,
      userId,
    );
    const visibleExists = this.scopeService.visibleExistsClause('s');
    const approvedExists = this.scopeService.approvedExistsClause('s');

    const { offset } = decodeCursor(cursor);

    const whereClauses: string[] = [`s.is_current = true`, visibleExists];
    const queryParams: Record<string, unknown> = { ...params };

    if (filters?.usableOnly !== false) {
      whereClauses.push(`s.usable = true`);
    }
    if (filters?.minQuality !== undefined) {
      whereClauses.push(`s.quality >= :min_quality`);
      queryParams['min_quality'] = filters.minQuality;
    }
    if (filters?.orientations?.length) {
      whereClauses.push(`s.orientation = ANY(:orientations)`);
      queryParams['orientations'] = filters.orientations;
    }
    if (filters?.shotSizes?.length) {
      whereClauses.push(`s.shot_size = ANY(:shot_sizes)`);
      queryParams['shot_sizes'] = filters.shotSizes;
    }
    if (filters?.q?.trim()) {
      // Simple text filter when search_vector may not exist yet; upgrade to FTS in search endpoint
      whereClauses.push(
        `(s.caption_vi ILIKE :q_pattern OR s.caption_en ILIKE :q_pattern OR :q_plain = ANY(s.tags))`,
      );
      queryParams['q_pattern'] = `%${filters.q.trim()}%`;
      queryParams['q_plain'] = filters.q.trim();
    }

    const whereStr = whereClauses.join(' AND ');

    const sql = `
      WITH ${cte}
      SELECT
        s.id            AS "segmentId",
        s.asset_id      AS "assetId",
        s.start_ms      AS "startMs",
        s.end_ms        AS "endMs",
        (s.end_ms - s.start_ms) AS "durationMs",
        s.caption_vi    AS "captionVi",
        s.caption_en    AS "captionEn",
        s.tags,
        s.keywords_vi   AS "keywordsVi",
        s.subjects,
        s.actions,
        s.shot_size     AS "shotSize",
        s.camera_motion AS "cameraMotion",
        s.time_of_day   AS "timeOfDay",
        s.setting,
        s.people_count  AS "peopleCount",
        s.orientation,
        s.quality,
        s.usable,
        (${approvedExists}) AS approved,
        p.folder_id     AS "folderIdSort",
        pm.project_id   AS "projectIdSort",
        s.asset_id      AS "assetIdSort",
        s.segment_index AS "segmentIndexSort"
      FROM media_segments s
      JOIN project_media pm ON pm.asset_id = s.asset_id AND pm.evaluation_status <> 'rejected'
      JOIN projects p ON p.id = pm.project_id AND p.folder_id = ANY(:scope_folder_ids)
      JOIN visible_projects vp ON vp.id = p.id
      WHERE ${whereStr}
      ORDER BY "folderIdSort", "projectIdSort", "assetIdSort", "segmentIndexSort"
      LIMIT :limit OFFSET :offset
    `;

    queryParams['scope_folder_ids'] = scopeFolderIds;
    queryParams['limit'] = limit + 1;
    queryParams['offset'] = offset;

    const { sql: catalogSql, params: catalogParams } = FootageScopeService.toPositional(
      sql,
      queryParams,
    );
    const rows = (await this.dataSource.query(catalogSql, catalogParams)) as Array<
      CatalogItem & {
        folderIdSort: string;
        projectIdSort: string;
        assetIdSort: string;
        segmentIndexSort: number;
      }
    >;

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: items.map((row): CatalogItem => ({
        segmentId: row.segmentId,
        assetId: row.assetId,
        startMs: row.startMs,
        endMs: row.endMs,
        durationMs: row.durationMs,
        captionVi: row.captionVi,
        captionEn: row.captionEn,
        tags: row.tags,
        keywordsVi: row.keywordsVi,
        subjects: row.subjects,
        actions: row.actions,
        shotSize: row.shotSize,
        cameraMotion: row.cameraMotion,
        timeOfDay: row.timeOfDay,
        setting: row.setting,
        peopleCount: row.peopleCount,
        orientation: row.orientation,
        quality: row.quality,
        usable: row.usable,
        approved: row.approved,
      })),
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /footage/segments/:segmentId/media
  // ---------------------------------------------------------------------------

  async getSegmentMedia(
    segmentId: string,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    segmentId: string;
    assetId: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    keyframeUrls: string[];
    previewUrl: string | null;
    previewWidth: number | null;
  }> {
    await this.scopeService.assertSegmentsInScope([segmentId], { userId, userType });

    const segment = await this.segmentRepo.findOne({ where: { id: segmentId } });
    if (!segment) {
      throw new NotFoundException(`Segment ${segmentId} not found`);
    }

    const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;

    // Resolve keyframe URLs
    const keyframeUrls: string[] = [];
    if (Array.isArray(segment.keyframes)) {
      const analysis = await this.analysisRepo.findOne({ where: { id: segment.analysisId } });
      const asset = analysis
        ? await this.assetRepo.findOne({ where: { id: segment.assetId } })
        : null;

      if (asset && analysis) {
        const analysisPrefix = `${assetVariantsPrefix(asset.originalStorageKey, asset.id)}analysis/${analysis.id}/`;
        for (const kf of segment.keyframes) {
          const kfObj = kf as { output?: string };
          if (kfObj.output) {
            try {
              const url = await this.storage.getPresignedGetUrl(
                `${analysisPrefix}${kfObj.output}`,
                'image/jpeg',
                ttl,
              );
              keyframeUrls.push(url);
            } catch {
              // Skip missing keyframes rather than failing the whole request
            }
          }
        }
      }
    }

    // Best servable preview variant
    const [variants, profile] = await Promise.all([
      this.variantRepo.find({ where: { assetId: segment.assetId, status: 'ready' } }),
      findActiveRenderProfile(this.renderProfileRepo),
    ]);
    const previews = variants.filter(
      (v) => isPreviewVariantCode(v.variantCode) && isVariantServable(v, profile),
    );
    previews.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    const bestPreview = previews[0] ?? null;

    let previewUrl: string | null = null;
    if (bestPreview) {
      previewUrl = await this.storage.getPresignedGetUrl(
        bestPreview.storageKey,
        bestPreview.mimeType,
        ttl,
      );
    }

    return {
      segmentId: segment.id,
      assetId: segment.assetId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      durationMs: segment.endMs - segment.startMs,
      keyframeUrls,
      previewUrl,
      previewWidth: bestPreview?.width ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /footage/segments/resolve
  // ---------------------------------------------------------------------------

  async resolveSegments(
    segmentIds: string[],
    purpose: ResolvePurpose,
    userId: string,
    userType?: 'ADMIN' | 'USER',
    userPermissions?: string[],
    requestId?: string,
  ): Promise<{ items: ResolvedSegmentItem[] }> {
    await this.scopeService.assertSegmentsInScope(segmentIds, { userId, userType });

    const segments = await this.segmentRepo.find({
      where: { id: In(segmentIds), isCurrent: true },
    });

    const canAccessOriginal =
      isAdminUserType(userType) ||
      userPermissions?.includes(GO_PERMISSIONS.PROJECT_EVALUATE) ||
      userPermissions?.includes(GO_PERMISSIONS.PROJECT_DOWNLOAD_ORIGINAL);

    const ttl = this.config.get<number>('FARM_URL_TTL_SECONDS') ?? 3600;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const profile = await findActiveRenderProfile(this.renderProfileRepo);

    const items: ResolvedSegmentItem[] = [];

    for (const segment of segments) {
      const asset = await this.assetRepo.findOne({ where: { id: segment.assetId } });
      if (!asset) continue;

      let url: string;
      let sourceKind: 'original' | 'proxy' | 'preview';
      let watermarked: boolean;
      let contentType: string;
      let sizeBytes: number | null = null;
      let cacheKey: string | null = null;

      if (canAccessOriginal) {
        // Decision 8: user with download_original or evaluate gets original/proxy
        if (purpose === 'final') {
          // Original file
          url = await this.storage.getPresignedGetUrl(
            asset.originalStorageKey,
            asset.mimeType,
            ttl,
          );
          sourceKind = 'original';
          watermarked = false;
          contentType = asset.mimeType;
          sizeBytes = Number(asset.fileSizeBytes) || null;
          cacheKey = `original:${asset.id}`;
        } else {
          // Preview → analysis proxy.mp4, fallback to original
          const analysis = await this.analysisRepo.findOne({
            where: { assetId: segment.assetId, isCurrent: true },
          });
          if (analysis) {
            const proxyKey = `${assetVariantsPrefix(asset.originalStorageKey, asset.id)}analysis/${analysis.id}/proxy.mp4`;
            try {
              const head = await this.storage.headObject(proxyKey);
              if (head) {
                url = await this.storage.getPresignedGetUrl(proxyKey, 'video/mp4', ttl);
                sourceKind = 'proxy';
                watermarked = false;
                contentType = 'video/mp4';
                sizeBytes = head.sizeBytes;
                cacheKey = `proxy:${analysis.id}`;
              } else {
                throw new Error('proxy not found');
              }
            } catch {
              url = await this.storage.getPresignedGetUrl(
                asset.originalStorageKey,
                asset.mimeType,
                ttl,
              );
              sourceKind = 'original';
              watermarked = false;
              contentType = asset.mimeType;
              sizeBytes = Number(asset.fileSizeBytes) || null;
              cacheKey = `original:${asset.id}`;
            }
          } else {
            url = await this.storage.getPresignedGetUrl(
              asset.originalStorageKey,
              asset.mimeType,
              ttl,
            );
            sourceKind = 'original';
            watermarked = false;
            contentType = asset.mimeType;
            sizeBytes = Number(asset.fileSizeBytes) || null;
            cacheKey = `original:${asset.id}`;
          }
        }
      } else {
        // User without download rights → best servable preview variant (watermarked)
        const variants = await this.variantRepo.find({
          where: { assetId: segment.assetId, status: 'ready' },
        });
        const previews = variants
          .filter((v) => isPreviewVariantCode(v.variantCode) && isVariantServable(v, profile))
          .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
        const bestPreview = previews[0];
        if (!bestPreview) {
          // No preview available; skip this segment
          continue;
        }
        url = await this.storage.getPresignedGetUrl(
          bestPreview.storageKey,
          bestPreview.mimeType,
          ttl,
        );
        sourceKind = 'preview';
        watermarked = bestPreview.hasWatermark;
        contentType = bestPreview.mimeType;
        sizeBytes = Number(bestPreview.fileSizeBytes) || null;
        cacheKey = `variant:${bestPreview.id}`;
      }

      items.push({
        segmentId: segment.id,
        assetId: segment.assetId,
        startMs: segment.startMs,
        endMs: segment.endMs,
        url,
        sourceKind,
        watermarked,
        contentType,
        sizeBytes,
        cacheKey,
        expiresAt,
      });
    }

    // Audit
    try {
      await this.systemLog.write({
        level: 'info',
        category: 'footage',
        action: 'resolve',
        message: `Resolved ${items.length} segments for userId=${userId} purpose=${purpose}`,
        requestId,
        userId,
        metadata: {
          segmentCount: items.length,
          purpose,
          canAccessOriginal,
        },
      });
    } catch {
      // Audit failure must not block the response
    }

    return { items };
  }

  // ---------------------------------------------------------------------------
  // GET /footage/search
  // ---------------------------------------------------------------------------

  async search(
    query: FootageSearchQueryDto,
    userId: string,
    userType?: 'ADMIN' | 'USER',
  ): Promise<{
    items: Array<
      CatalogItem & {
        score: number;
        keyframeUrl: string | null;
        assetName: string;
        projectNames: string[];
      }
    >;
    nextCursor: string | null;
  }> {
    const limit = Math.min(query.limit ?? 40, 100);
    const { offset } = decodeCursor(query.cursor);

    const accessibleFolderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    const scopeFolderIds = query.folderIds?.length
      ? await this.scopeService.expandToAccessibleSubtree(query.folderIds, accessibleFolderIds)
      : accessibleFolderIds;

    if (scopeFolderIds.length === 0) {
      return { items: [], nextCursor: null };
    }

    const isAdmin = isAdminUserType(userType);
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdmin,
      scopeFolderIds,
      userId,
    );
    const visibleExists = this.scopeService.visibleExistsClause('s');
    const approvedExists = this.scopeService.approvedExistsClause('s');

    const whereClauses: string[] = [`s.is_current = true`, visibleExists];
    const queryParams: Record<string, unknown> = { ...params };

    if (query.usableOnly !== false) {
      whereClauses.push(`s.usable = true`);
    }
    if (query.orientations?.length) {
      whereClauses.push(`s.orientation = ANY(:orientations)`);
      queryParams['orientations'] = query.orientations;
    }
    if (query.shotSizes?.length) {
      whereClauses.push(`s.shot_size = ANY(:shot_sizes)`);
      queryParams['shot_sizes'] = query.shotSizes;
    }
    if (query.timesOfDay?.length) {
      whereClauses.push(`s.time_of_day = ANY(:times_of_day)`);
      queryParams['times_of_day'] = query.timesOfDay;
    }
    if (query.tags?.length) {
      whereClauses.push(`s.tags && :filter_tags`);
      queryParams['filter_tags'] = query.tags;
    }
    if (query.minDurationMs !== undefined) {
      whereClauses.push(`(s.end_ms - s.start_ms) >= :min_dur`);
      queryParams['min_dur'] = query.minDurationMs;
    }
    if (query.maxDurationMs !== undefined) {
      whereClauses.push(`(s.end_ms - s.start_ms) <= :max_dur`);
      queryParams['max_dur'] = query.maxDurationMs;
    }
    if (query.categoryIds?.length) {
      whereClauses.push(`p.category_id = ANY(:category_ids)`);
      queryParams['category_ids'] = query.categoryIds;
    }
    if (query.provinceIds?.length) {
      whereClauses.push(`p.province_id = ANY(:province_ids)`);
      queryParams['province_ids'] = query.provinceIds;
    }

    // FTS or trigram search
    let scoreExpr = '1.0';
    if (query.q?.trim()) {
      const q = query.q.trim();
      queryParams['search_q'] = q;
      // Use search_vector for FTS ranking + quality/approval boost
      scoreExpr = `(
        COALESCE(ts_rank(s.search_vector, websearch_to_tsquery('simple', immutable_unaccent(:search_q))), 0.0)
        -- accent-exact bonus: reward segments whose original (non-de-accented) text closely
        -- matches the original query (captures accented-query → accented-caption advantage)
        + similarity(coalesce(s.caption_vi,''), :search_q) * 0.2
        + similarity(coalesce(s.caption_en,''), :search_q) * 0.1
        -- quality bonus (0–0.5)
        + COALESCE(s.quality, 0) * 0.1
        -- approved boost
        + CASE WHEN (${approvedExists}) THEN 0.05 ELSE 0.0 END
      )`;
      whereClauses.push(
        `(s.search_vector @@ websearch_to_tsquery('simple', immutable_unaccent(:search_q))
          OR similarity(immutable_unaccent(lower(coalesce(s.caption_vi,''))), immutable_unaccent(lower(:search_q))) > 0.15
          OR similarity(immutable_unaccent(lower(coalesce(s.caption_en,''))), immutable_unaccent(lower(:search_q))) > 0.15)`,
      );
    }

    const whereStr = whereClauses.join(' AND ');

    const sql = `
      WITH ${cte}
      SELECT
        s.id            AS "segmentId",
        s.asset_id      AS "assetId",
        s.start_ms      AS "startMs",
        s.end_ms        AS "endMs",
        (s.end_ms - s.start_ms) AS "durationMs",
        s.caption_vi    AS "captionVi",
        s.caption_en    AS "captionEn",
        s.tags,
        s.keywords_vi   AS "keywordsVi",
        s.subjects,
        s.actions,
        s.shot_size     AS "shotSize",
        s.camera_motion AS "cameraMotion",
        s.time_of_day   AS "timeOfDay",
        s.setting,
        s.people_count  AS "peopleCount",
        s.orientation,
        s.quality,
        s.usable,
        (${approvedExists}) AS approved,
        ${scoreExpr} AS score,
        a.original_filename AS "assetName",
        array_agg(DISTINCT p.name) AS "projectNames",
        s.keyframes     AS "keyframesRaw"
      FROM media_segments s
      JOIN assets a ON a.id = s.asset_id
      JOIN project_media pm ON pm.asset_id = s.asset_id AND pm.evaluation_status <> 'rejected'
      JOIN projects p ON p.id = pm.project_id AND p.folder_id = ANY(:scope_folder_ids)
      JOIN visible_projects vp ON vp.id = p.id
      WHERE ${whereStr}
      GROUP BY s.id, a.original_filename, s.caption_vi, s.caption_en
      ORDER BY score DESC, s.id
      LIMIT :limit OFFSET :offset
    `;

    queryParams['scope_folder_ids'] = scopeFolderIds;
    queryParams['limit'] = limit + 1;
    queryParams['offset'] = offset;

    type SearchRow = CatalogItem & {
      score: number;
      assetName: string;
      projectNames: string[];
      keyframesRaw: unknown[] | null;
    };
    const { sql: searchSql, params: searchParams } = FootageScopeService.toPositional(
      sql,
      queryParams,
    );
    const rows = (await this.dataSource.query(searchSql, searchParams)) as SearchRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const ttl = this.config.get<number>('R2_PRESIGNED_URL_TTL_SECONDS') ?? 900;

    // Resolve first keyframe URL for each segment (best-effort)
    const items = await Promise.all(
      pageRows.map(async (row) => {
        let keyframeUrl: string | null = null;
        const kfs = Array.isArray(row.keyframesRaw) ? row.keyframesRaw : [];
        const firstKf = (kfs[0] as { output?: string } | undefined)?.output;
        if (firstKf) {
          try {
            const asset = await this.assetRepo.findOne({ where: { id: row.assetId } });
            const analysis = asset
              ? await this.analysisRepo.findOne({
                  where: { assetId: row.assetId, isCurrent: true },
                })
              : null;
            if (asset && analysis) {
              const prefix = `${assetVariantsPrefix(asset.originalStorageKey, asset.id)}analysis/${analysis.id}/`;
              keyframeUrl = await this.storage.getPresignedGetUrl(
                `${prefix}${firstKf}`,
                'image/jpeg',
                ttl,
              );
            }
          } catch {
            // Skip
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { keyframesRaw: _kfr, ...rest } = row;
        return { ...rest, keyframeUrl };
      }),
    );

    return {
      items,
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
    tags: Array<{ value: string; count: number }>;
    shotSizes: Array<{ value: string; count: number }>;
    timesOfDay: Array<{ value: string; count: number }>;
    orientations: Array<{ value: string; count: number }>;
    categories: Array<{ id: string; name: string; count: number }>;
    provinces: Array<{ id: string; name: string; count: number }>;
  }> {
    const accessibleFolderIds = await this.folderAccess.accessibleFolderIds(userId, userType);
    const scopeFolderIds = query.folderIds?.length
      ? await this.scopeService.expandToAccessibleSubtree(query.folderIds, accessibleFolderIds)
      : accessibleFolderIds;

    if (scopeFolderIds.length === 0) {
      return {
        tags: [],
        shotSizes: [],
        timesOfDay: [],
        orientations: [],
        categories: [],
        provinces: [],
      };
    }

    const isAdmin = isAdminUserType(userType);
    const { cte, params } = this.scopeService.buildVisibleProjectsCte(
      isAdmin,
      scopeFolderIds,
      userId,
    );
    const visibleExists = this.scopeService.visibleExistsClause('s');

    const whereClauses: string[] = [`s.is_current = true`, visibleExists];
    const queryParams: Record<string, unknown> = { ...params, scope_folder_ids: scopeFolderIds };

    if (query.usableOnly !== false) {
      whereClauses.push(`s.usable = true`);
    }
    if (query.orientations?.length) {
      whereClauses.push(`s.orientation = ANY(:orientations)`);
      queryParams['orientations'] = query.orientations;
    }
    if (query.shotSizes?.length) {
      whereClauses.push(`s.shot_size = ANY(:shot_sizes)`);
      queryParams['shot_sizes'] = query.shotSizes;
    }
    if (query.timesOfDay?.length) {
      whereClauses.push(`s.time_of_day = ANY(:times_of_day)`);
      queryParams['times_of_day'] = query.timesOfDay;
    }
    if (query.tags?.length) {
      whereClauses.push(`s.tags && :filter_tags`);
      queryParams['filter_tags'] = query.tags;
    }
    if (query.categoryIds?.length) {
      whereClauses.push(`p.category_id = ANY(:category_ids)`);
      queryParams['category_ids'] = query.categoryIds;
    }
    if (query.provinceIds?.length) {
      whereClauses.push(`p.province_id = ANY(:province_ids)`);
      queryParams['province_ids'] = query.provinceIds;
    }

    const whereStr = whereClauses.join(' AND ');
    const baseFrom = `
      FROM media_segments s
      JOIN project_media pm ON pm.asset_id = s.asset_id AND pm.evaluation_status <> 'rejected'
      JOIN projects p ON p.id = pm.project_id AND p.folder_id = ANY(:scope_folder_ids)
      JOIN visible_projects vp ON vp.id = p.id
    `;

    const tagsSql = `
      WITH ${cte}
      SELECT unnest(s.tags) AS value, COUNT(DISTINCT s.id) AS count
      ${baseFrom}
      WHERE ${whereStr} AND s.tags IS NOT NULL AND array_length(s.tags, 1) > 0
      GROUP BY value ORDER BY count DESC LIMIT 30
    `;
    const shotSql = `
      WITH ${cte}
      SELECT s.shot_size AS value, COUNT(DISTINCT s.id) AS count
      ${baseFrom}
      WHERE ${whereStr} AND s.shot_size IS NOT NULL
      GROUP BY value ORDER BY count DESC LIMIT 30
    `;
    const todSql = `
      WITH ${cte}
      SELECT s.time_of_day AS value, COUNT(DISTINCT s.id) AS count
      ${baseFrom}
      WHERE ${whereStr} AND s.time_of_day IS NOT NULL
      GROUP BY value ORDER BY count DESC LIMIT 30
    `;
    const orientSql = `
      WITH ${cte}
      SELECT s.orientation AS value, COUNT(DISTINCT s.id) AS count
      ${baseFrom}
      WHERE ${whereStr} AND s.orientation IS NOT NULL
      GROUP BY value ORDER BY count DESC LIMIT 30
    `;
    const catSql = `
      WITH ${cte}
      SELECT p.category_id AS id, COUNT(DISTINCT s.id) AS count
      ${baseFrom}
      WHERE ${whereStr} AND p.category_id IS NOT NULL
      GROUP BY p.category_id ORDER BY count DESC LIMIT 30
    `;
    const provSql = `
      WITH ${cte}
      SELECT p.province_id AS id, COUNT(DISTINCT s.id) AS count
      ${baseFrom}
      WHERE ${whereStr} AND p.province_id IS NOT NULL
      GROUP BY p.province_id ORDER BY count DESC LIMIT 30
    `;

    const toPos = (rawSql: string) => FootageScopeService.toPositional(rawSql, queryParams);
    const [tagsRows, shotRows, todRows, orientRows, catRows, provRows] = await Promise.all([
      (({ sql: s, params: p }) =>
        this.dataSource.query(s, p) as Promise<Array<{ value: string; count: string }>>)(
        toPos(tagsSql),
      ),
      (({ sql: s, params: p }) =>
        this.dataSource.query(s, p) as Promise<Array<{ value: string; count: string }>>)(
        toPos(shotSql),
      ),
      (({ sql: s, params: p }) =>
        this.dataSource.query(s, p) as Promise<Array<{ value: string; count: string }>>)(
        toPos(todSql),
      ),
      (({ sql: s, params: p }) =>
        this.dataSource.query(s, p) as Promise<Array<{ value: string; count: string }>>)(
        toPos(orientSql),
      ),
      (({ sql: s, params: p }) =>
        this.dataSource.query(s, p) as Promise<Array<{ id: string; count: string }>>)(
        toPos(catSql),
      ),
      (({ sql: s, params: p }) =>
        this.dataSource.query(s, p) as Promise<Array<{ id: string; count: string }>>)(
        toPos(provSql),
      ),
    ]);

    // Enrich categories and provinces with names
    const catIds = catRows.map((r) => r.id);
    const provIds = provRows.map((r) => r.id);

    const [catNames, provNames] = await Promise.all([
      catIds.length
        ? (this.dataSource.query(`SELECT id, name FROM categories WHERE id = ANY($1)`, [
            catIds,
          ]) as Promise<Array<{ id: string; name: string }>>)
        : Promise.resolve<Array<{ id: string; name: string }>>([]),
      provIds.length
        ? (this.dataSource.query(`SELECT id, name FROM provinces WHERE id = ANY($1)`, [
            provIds,
          ]) as Promise<Array<{ id: string; name: string }>>)
        : Promise.resolve<Array<{ id: string; name: string }>>([]),
    ]);

    const catNameMap = new Map(catNames.map((r) => [r.id, r.name]));
    const provNameMap = new Map(provNames.map((r) => [r.id, r.name]));

    return {
      tags: tagsRows.map((r) => ({ value: r.value, count: Number(r.count) })),
      shotSizes: shotRows.map((r) => ({ value: r.value, count: Number(r.count) })),
      timesOfDay: todRows.map((r) => ({ value: r.value, count: Number(r.count) })),
      orientations: orientRows.map((r) => ({ value: r.value, count: Number(r.count) })),
      categories: catRows.map((r) => ({
        id: r.id,
        name: catNameMap.get(r.id) ?? r.id,
        count: Number(r.count),
      })),
      provinces: provRows.map((r) => ({
        id: r.id,
        name: provNameMap.get(r.id) ?? r.id,
        count: Number(r.count),
      })),
    };
  }
}
