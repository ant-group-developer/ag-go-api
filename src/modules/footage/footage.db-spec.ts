/**
 * DB-level integration tests for the footage module.
 *
 * Runs against real Postgres (port 55434, started by docker-compose.test.yml).
 * All migrations run once in globalSetup before this file executes, so
 * `immutable_unaccent`, `search_vector` column, and related infrastructure exist.
 *
 * Tests cover the permission matrix from plan §GĐ2 Verification:
 *   - folder granted → visible; not granted → 0
 *   - subfolder access inherited from parent grant
 *   - asset in 2 projects, only 1 in scope → visible
 *   - rejected in only visible project → hidden
 *   - rejected in one but pending in another visible project → visible
 *   - other users' drafts hidden; own draft visible
 *   - ADMIN sees all projects
 *   - out-of-scope segment id → 404
 *   - folders endpoint lists only scoped folders
 *   - search: "pho bo" finds "phở bò", accented query ranks first
 *   - facets counts
 *   - resolve: user with download_original gets original; without gets preview (watermarked)
 */
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { MediaSegmentEntity } from '../../database/entities/media-segment.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { FolderAccessService } from '../folders/folder-access.service';
import { FootageScopeService } from './footage-scope.service';
import { FootageService } from './footage.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let footageService: FootageService;
let scopeService: FootageScopeService;
let folderAccess: FolderAccessService;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;

  folderAccess = new FolderAccessService(
    ds.getRepository(FolderAccessGrantEntity),
    ds.getRepository(FolderClosureEntity),
    ds.getRepository(FolderEntity),
  );
  scopeService = new FootageScopeService(folderAccess, ds);

  const fakeStorage = {
    getPresignedGetUrl: async (key: string) => `https://cdn.test/${key}?signed=1`,
    headObject: async () => null,
    getPresignedPutUrl: async () => 'https://put.test',
    readObject: () => {
      throw new Error('not impl');
    },
    putObject: async () => ({ sizeBytes: 0 }),
    copyObject: async () => ({ sizeBytes: 0 }),
    deleteObject: async () => undefined,
    deleteObjects: async () => undefined,
    listObjectsPage: async () => ({ objects: [], nextContinuationToken: null }),
    getObjectText: async () => '',
  };

  const fakeLog = { write: async () => undefined };

  footageService = new FootageService(
    scopeService,
    folderAccess,
    ds,
    ds.getRepository(FolderEntity),
    ds.getRepository(MediaSegmentEntity),
    ds.getRepository(AssetVariantEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AssetAnalysisEntity),
    ds.getRepository(RenderProfileEntity),
    fakeStorage as never,
    { get: (_k: string, def?: unknown) => def ?? 900 } as never,
    fakeLog as never,
  );
});

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

// Track created IDs for cleanup after each test
const createdAssetIds: string[] = [];
const createdFolderIds: string[] = [];
const createdProjectIds: string[] = [];

afterEach(async () => {
  // Projects cascade to project_media; assets cascade to segments, analyses, variants
  if (createdProjectIds.length) {
    await ds.query(`DELETE FROM projects WHERE id = ANY($1)`, [createdProjectIds]);
    createdProjectIds.length = 0;
  }
  if (createdAssetIds.length) {
    await ds.query(`DELETE FROM assets WHERE id = ANY($1)`, [createdAssetIds]);
    createdAssetIds.length = 0;
  }
  if (createdFolderIds.length) {
    await ds.query(`DELETE FROM folder_access_grants WHERE folder_id = ANY($1)`, [
      createdFolderIds,
    ]);
    await ds.query(`DELETE FROM folder_closure WHERE descendant_id = ANY($1)`, [createdFolderIds]);
    await ds.query(`DELETE FROM folder_closure WHERE ancestor_id = ANY($1)`, [createdFolderIds]);
    await ds.query(`DELETE FROM folders WHERE id = ANY($1)`, [createdFolderIds]);
    createdFolderIds.length = 0;
  }
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function insertFolder(parentId: string | null = null): Promise<string> {
  const id = randomUUID();
  const pathKey = parentId ? `/${parentId}/${id}` : `/${id}`;
  await ds.query(
    `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, sort_order, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      parentId,
      `Folder ${id.slice(0, 8)}`,
      pathKey,
      [], // uuid[] — empty array
      pathKey,
      parentId ? 1 : 0,
      0,
      true,
      'test',
    ],
  );
  // Self-closure entry
  await ds.query(
    `INSERT INTO folder_closure (ancestor_id, descendant_id, depth) VALUES ($1,$2,0)`,
    [id, id],
  );
  if (parentId) {
    // Copy all ancestor closures and add this folder as descendant
    await ds.query(
      `INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
       SELECT ancestor_id, $1, depth + 1 FROM folder_closure WHERE descendant_id = $2`,
      [id, parentId],
    );
  }
  createdFolderIds.push(id);
  return id;
}

async function grantFolder(
  folderId: string,
  userId: string,
  inheritChildren = true,
): Promise<void> {
  await ds.query(
    `INSERT INTO folder_access_grants (id, folder_id, principal_type, principal_id, access_level, inherit_children)
     VALUES ($1,$2,'user',$3,'viewer',$4)`,
    [randomUUID(), folderId, userId, inheritChildren],
  );
}

async function insertAsset(storageKey?: string): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO assets (id, asset_type, original_filename, mime_type, file_size_bytes,
       storage_provider, original_bucket, original_storage_key, processing_status,
       source_type, source_metadata, created_by)
     VALUES ($1,'video','clip.mp4','video/mp4',1024000,'r2','ag-go',$2,'ready','local','{}','test')`,
    [id, storageKey ?? `projects/p1/originals/${id}/clip.mp4`],
  );
  createdAssetIds.push(id);
  return id;
}

async function insertAnalysis(assetId: string, isCurrent = true): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO asset_analyses (id, asset_id, status, is_current, priority)
     VALUES ($1,$2,'completed',$3,0)`,
    [id, assetId, isCurrent],
  );
  return id;
}

async function insertSegment(
  assetId: string,
  analysisId: string,
  overrides: {
    isCurrent?: boolean;
    usable?: boolean;
    quality?: number;
    captionVi?: string | null;
    captionEn?: string | null;
    tags?: string[] | null;
    keywordsVi?: string[] | null;
    orientation?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const {
    isCurrent = true,
    usable = true,
    quality = 4,
    captionVi = null,
    captionEn = null,
    tags = null,
    keywordsVi = null,
    orientation = 'landscape',
  } = overrides;
  await ds.query(
    `INSERT INTO media_segments
       (id, analysis_id, asset_id, segment_index, start_ms, end_ms,
        orientation, keyframes, technical, usable, quality, is_current,
        caption_vi, caption_en, tags, keywords_vi)
     VALUES ($1,$2,$3,0,0,5000,$4,'[]','{}', $5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      analysisId,
      assetId,
      orientation,
      usable,
      quality,
      isCurrent,
      captionVi,
      captionEn,
      tags,
      keywordsVi,
    ],
  );
  return id;
}

async function insertProject(
  folderId: string,
  overrides: {
    evaluationStatus?: string;
    ownerUserId?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO projects (id, owner_user_id, folder_id, name, evaluation_status)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      id,
      overrides.ownerUserId ?? 'user-owner',
      folderId,
      `Project ${id.slice(0, 8)}`,
      overrides.evaluationStatus ?? 'pending',
    ],
  );
  createdProjectIds.push(id);
  return id;
}

async function linkAssetToProject(
  assetId: string,
  projectId: string,
  evaluationStatus: 'pending' | 'approved' | 'rejected' = 'pending',
): Promise<void> {
  await ds.query(
    `INSERT INTO project_media (id, project_id, asset_id, sort_order, evaluation_status, created_by)
     VALUES ($1,$2,$3,0,$4,'test')`,
    [randomUUID(), projectId, assetId, evaluationStatus],
  );
}

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------

describe('FootageScopeService — permission matrix', () => {
  it('folder granted → segment visible', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('folder not granted → segment hidden (404)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('subfolder access inherited from parent grant', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const parentId = await insertFolder();
    const childId = await insertFolder(parentId);
    await grantFolder(parentId, userId, true);
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(childId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('asset in 2 projects — only 1 in scope → visible', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const grantedFolder = await insertFolder();
    const otherFolder = await insertFolder();
    await grantFolder(grantedFolder, userId);
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const p1 = await insertProject(grantedFolder);
    const p2 = await insertProject(otherFolder);
    await linkAssetToProject(assetId, p1);
    await linkAssetToProject(assetId, p2);

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('rejected in the only visible project → hidden', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId, 'rejected');

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejected in one project but pending in another visible project → visible', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const p1 = await insertProject(folderId);
    const p2 = await insertProject(folderId);
    await linkAssetToProject(assetId, p1, 'rejected');
    await linkAssetToProject(assetId, p2, 'pending');

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it("other user's draft is hidden", async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const ownerId = `owner-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId, {
      evaluationStatus: 'draft',
      ownerUserId: ownerId,
    });
    await linkAssetToProject(assetId, projectId, 'pending');

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('user can see their own draft', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId, {
      evaluationStatus: 'draft',
      ownerUserId: userId,
    });
    await linkAssetToProject(assetId, projectId, 'pending');

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('ADMIN sees all projects (even non-granted folders)', async () => {
    const adminId = `admin-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertSegmentsInScope([segId], { userId: adminId, userType: 'ADMIN' }),
    ).resolves.not.toThrow();
  });

  it('out-of-scope segment id → 404', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    await expect(
      scopeService.assertSegmentsInScope([randomUUID()], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// Folders endpoint
// ---------------------------------------------------------------------------

describe('FootageService.getFolders', () => {
  it('lists only scoped folders with correct counts', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const grantedFolder = await insertFolder();
    const otherFolder = await insertFolder();
    await grantFolder(grantedFolder, userId);

    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    await insertSegment(assetId, analysisId, { usable: true });
    const p = await insertProject(grantedFolder);
    await linkAssetToProject(assetId, p);

    const result = await footageService.getFolders(userId, 'USER');

    const ids = result.folders.map((f) => f.id);
    expect(ids).toContain(grantedFolder);
    expect(ids).not.toContain(otherFolder);

    const gf = result.folders.find((f) => f.id === grantedFolder);
    expect(gf?.analyzedSegments).toBeGreaterThanOrEqual(1);
    expect(gf?.usableSegments).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Search (FTS + accent-insensitive)
// ---------------------------------------------------------------------------

describe('FootageService.search — accent-insensitive FTS', () => {
  it('"pho bo" finds "phở bò" segment', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const a1 = await insertAsset();
    const an1 = await insertAnalysis(a1);
    await insertSegment(a1, an1, { captionVi: 'phở bò tái chín', usable: true });
    const p1 = await insertProject(folderId);
    await linkAssetToProject(a1, p1);

    // Trigger sets search_vector on insert; also force-update in case trigger is absent
    await ds.query(
      `UPDATE media_segments
       SET search_vector = setweight(to_tsvector('simple', immutable_unaccent(coalesce(caption_vi,''))), 'A')
       WHERE asset_id = $1`,
      [a1],
    );

    const result = await footageService.search({ q: 'pho bo', usableOnly: false }, userId, 'USER');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.some((i) => i.captionVi?.includes('phở bò'))).toBe(true);
  });

  it('accented query "phở bò" ranks above plain "pho bo thuong"', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const a1 = await insertAsset();
    const an1 = await insertAnalysis(a1);
    await insertSegment(a1, an1, { captionVi: 'phở bò tái chín', usable: true });
    const p1 = await insertProject(folderId);
    await linkAssetToProject(a1, p1);

    const a2 = await insertAsset();
    const an2 = await insertAnalysis(a2);
    await insertSegment(a2, an2, { captionVi: 'pho bo thuong', usable: true });
    const p2 = await insertProject(folderId);
    await linkAssetToProject(a2, p2);

    await ds.query(
      `UPDATE media_segments
       SET search_vector = setweight(to_tsvector('simple', immutable_unaccent(coalesce(caption_vi,''))), 'A')
       WHERE asset_id = ANY($1)`,
      [[a1, a2]],
    );

    const result = await footageService.search({ q: 'phở bò', usableOnly: false }, userId, 'USER');
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    // Accented segment should score higher (exact-accent bonus) and appear first
    expect(result.items[0].captionVi).toContain('phở bò');
  });
});

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe('FootageService.getFacets', () => {
  it('returns tag facets when segments have tags', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const a1 = await insertAsset();
    const an1 = await insertAnalysis(a1);
    await insertSegment(a1, an1, { tags: ['ẩm thực', 'đường phố'], usable: true });
    const p = await insertProject(folderId);
    await linkAssetToProject(a1, p);

    const facets = await footageService.getFacets({ usableOnly: true }, userId, 'USER');
    const tagValues = facets.tags.map((t) => t.value);
    expect(tagValues).toContain('ẩm thực');
    expect(tagValues).toContain('đường phố');
  });

  it('returns empty facets when user has no folder access', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const facets = await footageService.getFacets({}, userId, 'USER');
    expect(facets.tags).toEqual([]);
    expect(facets.shotSizes).toEqual([]);
    expect(facets.orientations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resolve (decision 8)
// ---------------------------------------------------------------------------

describe('FootageService.resolveSegments — decision 8', () => {
  it('user with go.project.download_original gets original (purpose=final)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    const result = await footageService.resolveSegments([segId], 'final', userId, 'USER', [
      'go.project.download_original',
    ]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceKind).toBe('original');
    expect(result.items[0].watermarked).toBe(false);
  });

  it('user with go.project.evaluate gets original (purpose=final)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    const result = await footageService.resolveSegments([segId], 'final', userId, 'USER', [
      'go.project.evaluate',
    ]);

    expect(result.items[0].sourceKind).toBe('original');
    expect(result.items[0].watermarked).toBe(false);
  });

  it('user without download rights gets preview variant (watermarked)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    // Insert a ready watermarked preview variant (cleaned up by assets cascade in afterEach)
    await ds.query(
      `INSERT INTO asset_variants
         (id, asset_id, render_profile_id, variant_code, render_version,
          storage_provider, bucket_name, storage_key, mime_type, file_size_bytes,
          width, height, has_watermark, status)
       VALUES ($1,$2,null,'preview_720',1,'r2','ag-go','variants/preview.mp4',
               'video/mp4',512000,1280,720,true,'ready')`,
      [randomUUID(), assetId],
    );

    const result = await footageService.resolveSegments(
      [segId],
      'preview',
      userId,
      'USER',
      ['go.footage.search'], // no download rights
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceKind).toBe('preview');
    expect(result.items[0].watermarked).toBe(true);
  });

  it('user without download rights and no preview variant → segment omitted', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const segId = await insertSegment(assetId, analysisId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    // No variants inserted for this asset
    const result = await footageService.resolveSegments([segId], 'preview', userId, 'USER', [
      'go.footage.search',
    ]);

    expect(result.items).toHaveLength(0);
  });
});
