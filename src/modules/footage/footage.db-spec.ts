/**
 * DB-level integration tests for the footage module (v2: per-asset analysis).
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
 *   - out-of-scope asset id → 404
 *   - picking a parent folder covers its reachable subfolders (catalog, search, facets)
 *   - folders endpoint lists only scoped folders with analyzedVideos/usableVideos counts
 *   - search: "pho bo" finds "phở bò", accented query ranks first
 *   - facets counts (tags, genres, orientations)
 *   - catalog: one row per video even when it belongs to several visible projects; best quality first
 *   - resolve: user with download_original gets original (final) or the analysis proxy (preview);
 *     without gets preview (watermarked)
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
/** Storage keys that exist in the fake bucket (key → size), for headObject. */
const storedObjects = new Map<string, number>();

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
    headObject: async (key: string) =>
      storedObjects.has(key)
        ? { sizeBytes: storedObjects.get(key)!, contentType: 'video/mp4' }
        : null,
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
    ds.getRepository(AssetVariantEntity),
    ds.getRepository(AssetEntity),
    ds.getRepository(AssetAnalysisEntity),
    ds.getRepository(RenderProfileEntity),
    fakeStorage as never,
    { get: (_k: string, def?: unknown) => def ?? 900 } as never,
    fakeLog as never,
    { enrich: async <T>(rows: T[]) => rows } as never,
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
  storedObjects.clear();
  // Projects cascade to project_media; assets cascade to analyses, variants
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
      [],
      pathKey,
      parentId ? 1 : 0,
      0,
      true,
      'test',
    ],
  );
  await ds.query(
    `INSERT INTO folder_closure (ancestor_id, descendant_id, depth) VALUES ($1,$2,0)`,
    [id, id],
  );
  if (parentId) {
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

/**
 * Default description for insertAnalysis. Fields match AssetDescriptionSchema.
 */
function makeDescription(
  overrides: {
    titleVi?: string;
    tags?: string[];
    genre?: string;
    usable?: boolean;
    quality?: number;
  } = {},
): Record<string, unknown> {
  return {
    title_vi: overrides.titleVi ?? 'Cảnh quay mặc định',
    summary_vi: 'Mô tả mặc định',
    summary_en: 'Default description',
    genre: overrides.genre ?? 'test',
    topics: [],
    subjects: [],
    places: [],
    actions: [],
    keywords_vi: [],
    tags: overrides.tags ?? [],
    mood: 'calm',
    setting: 'outdoor',
    time_of_day: 'day',
    people_count: 'none',
    shot_variety: ['wide'],
    camera_motions: ['static'],
    visible_text: '',
    has_watermark: false,
    usable: overrides.usable ?? true,
    usable_reason: '',
    quality: overrides.quality ?? 4,
  };
}

async function insertAnalysis(
  assetId: string,
  isCurrent = true,
  overrides: {
    usable?: boolean;
    description?: Record<string, unknown> | null;
    orientation?: string;
    quality?: number;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const usable = overrides.usable ?? true;
  // null means "do not set description" (no description for in-progress analyses)
  const description =
    overrides.description !== undefined ? overrides.description : makeDescription({ usable });
  await ds.query(
    `INSERT INTO asset_analyses
       (id, asset_id, status, is_current, priority, description, usable, quality, orientation)
     VALUES ($1,$2,'completed',$3,0,$4,$5,$6,$7)`,
    [
      id,
      assetId,
      isCurrent,
      description ? JSON.stringify(description) : null,
      usable,
      overrides.quality ?? 4,
      overrides.orientation ?? 'landscape',
    ],
  );
  return id;
}

async function insertProject(
  folderId: string,
  overrides: { evaluationStatus?: string; ownerUserId?: string } = {},
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
  it('folder granted → asset visible', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('folder not granted → asset hidden (404)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    const assetId = await insertAsset();
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('subfolder access inherited from parent grant', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const parentId = await insertFolder();
    const childId = await insertFolder(parentId);
    await grantFolder(parentId, userId, true);
    const assetId = await insertAsset();
    const projectId = await insertProject(childId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('asset in 2 projects — only 1 in scope → visible', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const grantedFolder = await insertFolder();
    const otherFolder = await insertFolder();
    await grantFolder(grantedFolder, userId);
    const assetId = await insertAsset();
    const p1 = await insertProject(grantedFolder);
    const p2 = await insertProject(otherFolder);
    await linkAssetToProject(assetId, p1);
    await linkAssetToProject(assetId, p2);

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('rejected in the only visible project → hidden', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId, 'rejected');

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejected in one project but pending in another visible project → visible', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const p1 = await insertProject(folderId);
    const p2 = await insertProject(folderId);
    await linkAssetToProject(assetId, p1, 'rejected');
    await linkAssetToProject(assetId, p2, 'pending');

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it("other user's draft is hidden", async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const ownerId = `owner-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const projectId = await insertProject(folderId, {
      evaluationStatus: 'draft',
      ownerUserId: ownerId,
    });
    await linkAssetToProject(assetId, projectId, 'pending');

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('user can see their own draft', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const assetId = await insertAsset();
    const projectId = await insertProject(folderId, {
      evaluationStatus: 'draft',
      ownerUserId: userId,
    });
    await linkAssetToProject(assetId, projectId, 'pending');

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId, userType: 'USER' }),
    ).resolves.not.toThrow();
  });

  it('ADMIN sees all projects (even non-granted folders)', async () => {
    const adminId = `admin-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    const assetId = await insertAsset();
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    await expect(
      scopeService.assertAssetsInScope([assetId], { userId: adminId, userType: 'ADMIN' }),
    ).resolves.not.toThrow();
  });

  it('out-of-scope asset id → 404', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    await expect(
      scopeService.assertAssetsInScope([randomUUID()], { userId, userType: 'USER' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// Folder subtree (picking a parent folder covers its subfolders)
// ---------------------------------------------------------------------------

describe('FootageService — folder subtree', () => {
  async function seedGrandchild(): Promise<{ rootId: string; childId: string; assetId: string }> {
    const rootId = await insertFolder();
    const childId = await insertFolder(rootId);
    const grandchildId = await insertFolder(childId);
    const assetId = await insertAsset();
    await insertAnalysis(assetId, true, {
      description: makeDescription({ titleVi: 'quảng trường cỏ xanh', tags: ['quảng trường'] }),
    });
    const projectId = await insertProject(grandchildId);
    await linkAssetToProject(assetId, projectId);
    return { rootId, childId, assetId };
  }

  it('catalog on a parent folder returns footage of projects in its subfolders', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const { rootId, assetId } = await seedGrandchild();
    await grantFolder(rootId, userId, true);

    const result = await footageService.getCatalog({ folderIds: [rootId] }, userId, 'USER');
    expect(result.items.map((i) => i.assetId)).toContain(assetId);
  });

  it('catalog skips subfolders the user cannot reach', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const { rootId } = await seedGrandchild();
    await grantFolder(rootId, userId, false);

    const result = await footageService.getCatalog({ folderIds: [rootId] }, userId, 'USER');
    expect(result.items).toEqual([]);
  });

  it('ADMIN catalog on a parent folder covers its subfolders', async () => {
    const { rootId, assetId } = await seedGrandchild();

    const result = await footageService.getCatalog({ folderIds: [rootId] }, 'admin-1', 'ADMIN');
    expect(result.items.map((i) => i.assetId)).toContain(assetId);
  });

  it('search and facets filtered by a parent folder cover its subfolders', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const { rootId, childId, assetId } = await seedGrandchild();
    await grantFolder(childId, userId, true);

    // The root itself is out of reach, but the subfolders granted below it are searched.
    const found = await footageService.search({ folderIds: [rootId] }, userId, 'USER');
    expect(found.items.map((i) => i.assetId)).toContain(assetId);

    const facets = await footageService.getFacets({ folderIds: [childId] }, userId, 'USER');
    expect(facets.tags.map((t) => t.value)).toContain('quảng trường');
  });
});

// ---------------------------------------------------------------------------
// Folders endpoint
// ---------------------------------------------------------------------------

describe('FootageService.getCatalog — one row per video', () => {
  it('lists a video in two visible projects once, best quality first', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const projectA = await insertProject(folderId);
    const projectB = await insertProject(folderId);

    const shared = await insertAsset();
    await insertAnalysis(shared, true, { quality: 3 });
    await linkAssetToProject(shared, projectA);
    await linkAssetToProject(shared, projectB);
    const best = await insertAsset();
    await insertAnalysis(best, true, { quality: 5 });
    await linkAssetToProject(best, projectA);
    const worst = await insertAsset();
    await insertAnalysis(worst, true, { quality: 2 });
    await linkAssetToProject(worst, projectB);

    const result = await footageService.getCatalog({ folderIds: [folderId] }, userId, 'USER');
    expect(result.items.map((i) => i.assetId)).toEqual([best, shared, worst]);
    const sharedRow = result.items.find((i) => i.assetId === shared)!;
    expect([...sharedRow.projectIds].sort()).toEqual([projectA, projectB].sort());
  });
});

describe('FootageService.getFolders', () => {
  it('lists only scoped folders with correct analyzedVideos and usableVideos counts', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const grantedFolder = await insertFolder();
    const otherFolder = await insertFolder();
    await grantFolder(grantedFolder, userId);

    const assetId = await insertAsset();
    await insertAnalysis(assetId, true, { usable: true });
    const p = await insertProject(grantedFolder);
    await linkAssetToProject(assetId, p);

    const result = await footageService.getFolders(userId, 'USER');

    const ids = result.folders.map((f) => f.id);
    expect(ids).toContain(grantedFolder);
    expect(ids).not.toContain(otherFolder);

    const gf = result.folders.find((f) => f.id === grantedFolder);
    expect(gf?.analyzedVideos).toBeGreaterThanOrEqual(1);
    expect(gf?.usableVideos).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Search (FTS + accent-insensitive)
// ---------------------------------------------------------------------------

describe('FootageService.search — accent-insensitive FTS', () => {
  it('"pho bo" finds "phở bò" asset', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const a1 = await insertAsset();
    await insertAnalysis(a1, true, {
      description: makeDescription({ titleVi: 'phở bò tái chín' }),
    });
    const p1 = await insertProject(folderId);
    await linkAssetToProject(a1, p1);

    // Force-populate the search_vector on asset_analyses
    await ds.query(
      `UPDATE asset_analyses
       SET search_vector = setweight(to_tsvector('simple', immutable_unaccent(
         coalesce(description ->> 'title_vi', '') || ' ' ||
         coalesce(description ->> 'summary_vi', '')
       )), 'A')
       WHERE asset_id = $1`,
      [a1],
    );

    const result = await footageService.search({ q: 'pho bo', usableOnly: false }, userId, 'USER');
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.some((i) => i.titleVi?.includes('phở bò'))).toBe(true);
  });

  it('accented query "phở bò" ranks above plain "pho bo thuong"', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const a1 = await insertAsset();
    await insertAnalysis(a1, true, {
      description: makeDescription({ titleVi: 'phở bò tái chín' }),
    });
    const p1 = await insertProject(folderId);
    await linkAssetToProject(a1, p1);

    const a2 = await insertAsset();
    await insertAnalysis(a2, true, {
      description: makeDescription({ titleVi: 'pho bo thuong' }),
    });
    const p2 = await insertProject(folderId);
    await linkAssetToProject(a2, p2);

    await ds.query(
      `UPDATE asset_analyses
       SET search_vector = setweight(to_tsvector('simple', immutable_unaccent(
         coalesce(description ->> 'title_vi', '') || ' ' ||
         coalesce(description ->> 'summary_vi', '')
       )), 'A')
       WHERE asset_id = ANY($1)`,
      [[a1, a2]],
    );

    const result = await footageService.search({ q: 'phở bò', usableOnly: false }, userId, 'USER');
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    // Accented segment should score higher (exact-accent bonus) and appear first
    expect(result.items[0].titleVi).toContain('phở bò');
  });
});

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe('FootageService.getFacets', () => {
  it('returns tag facets from description.tags', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const a1 = await insertAsset();
    await insertAnalysis(a1, true, {
      description: makeDescription({ tags: ['ẩm thực', 'đường phố'], usable: true }),
    });
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
    expect(facets.orientations).toEqual([]);
    expect(facets.genres).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resolve (decision 8: resolveAssets)
// ---------------------------------------------------------------------------

describe('FootageService.resolveAssets — decision 8', () => {
  it('user with go.project.download_original gets original (purpose=final)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    await insertAnalysis(assetId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    const result = await footageService.resolveAssets([assetId], 'final', userId, 'USER', [
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
    await insertAnalysis(assetId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    const result = await footageService.resolveAssets([assetId], 'final', userId, 'USER', [
      'go.project.evaluate',
    ]);

    expect(result.items[0].sourceKind).toBe('original');
    expect(result.items[0].watermarked).toBe(false);
  });

  it('user with download rights gets the analysis proxy for a preview render', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    const analysisId = await insertAnalysis(assetId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);
    const proxyKey = `projects/p1/variants/${assetId}/analysis/${analysisId}/proxy.mp4`;
    storedObjects.set(proxyKey, 4242);

    const result = await footageService.resolveAssets([assetId], 'preview', userId, 'USER', [
      'go.project.download_original',
    ]);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceKind: 'proxy',
      watermarked: false,
      sizeBytes: 4242,
      cacheKey: `proxy:${analysisId}`,
    });
    expect(result.items[0].url).toContain(proxyKey);
  });

  it('user with download rights falls back to the original when the proxy is gone', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    await insertAnalysis(assetId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    const result = await footageService.resolveAssets([assetId], 'preview', userId, 'USER', [
      'go.project.download_original',
    ]);

    expect(result.items[0]).toMatchObject({
      sourceKind: 'original',
      cacheKey: `original:${assetId}`,
    });
  });

  it('user without download rights gets preview variant (watermarked)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    await insertAnalysis(assetId);
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

    const result = await footageService.resolveAssets(
      [assetId],
      'preview',
      userId,
      'USER',
      ['go.footage.search'], // no download rights
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceKind).toBe('preview');
    expect(result.items[0].watermarked).toBe(true);
  });

  it('user without download rights and no preview variant → asset omitted (missing)', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);

    const assetId = await insertAsset();
    await insertAnalysis(assetId);
    const projectId = await insertProject(folderId);
    await linkAssetToProject(assetId, projectId);

    // No variants inserted for this asset
    const result = await footageService.resolveAssets([assetId], 'preview', userId, 'USER', [
      'go.footage.search',
    ]);

    expect(result.items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Footage page: folder tree, filters, sorting, paging, detail
// ---------------------------------------------------------------------------

/** Frame size and duration the analysis measured. */
async function setAnalysedMedia(
  analysisId: string,
  media: { width: number; height: number; durationMs: number },
): Promise<void> {
  await ds.query(`UPDATE asset_analyses SET artifacts = $2, duration_ms = $3 WHERE id = $1`, [
    analysisId,
    JSON.stringify({ media: { width: media.width, height: media.height, fps: 25 } }),
    media.durationMs,
  ]);
}

async function renameFolder(folderId: string, name: string, sortOrder = 0): Promise<void> {
  await ds.query(`UPDATE folders SET name = $2, sort_order = $3 WHERE id = $1`, [
    folderId,
    name,
    sortOrder,
  ]);
}

/** One analysed video of `projectId`. */
async function insertVideo(
  projectId: string,
  media: { width: number; height: number; durationMs: number },
): Promise<string> {
  const assetId = await insertAsset();
  const analysisId = await insertAnalysis(assetId);
  await setAnalysedMedia(analysisId, media);
  await linkAssetToProject(assetId, projectId);
  return assetId;
}

describe('FootageService.getFolders — folder tree', () => {
  it('hides deleted folders and lists parents first, then sort order and natural name', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const root = await insertFolder();
    await grantFolder(root, userId);
    const child10 = await insertFolder(root);
    const child9 = await insertFolder(root);
    const deleted = await insertFolder(root);
    await renameFolder(root, 'Root');
    await renameFolder(child10, 'Cảnh 10');
    await renameFolder(child9, 'Cảnh 9');
    await renameFolder(deleted, 'Cảnh 1');
    await ds.query(`UPDATE folders SET is_active = false WHERE id = $1`, [deleted]);

    const { folders } = await footageService.getFolders(userId, 'USER');

    expect(folders.map((f) => f.id)).toEqual([root, child9, child10]);
  });
});

describe('FootageService.search — filters, sorting and paging', () => {
  it('filters by project, author and resolution class', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const projectA = await insertProject(folderId, { ownerUserId: 'author-a' });
    const projectB = await insertProject(folderId, { ownerUserId: 'author-b' });
    const uhd = await insertVideo(projectA, { width: 3840, height: 2160, durationMs: 5_000 });
    const hd = await insertVideo(projectB, { width: 1920, height: 1080, durationMs: 9_000 });
    const portraitHd = await insertVideo(projectB, { width: 720, height: 1280, durationMs: 1_000 });

    const ids = async (query: Parameters<FootageService['search']>[0]) =>
      (await footageService.search(query, userId, 'USER')).items.map((i) => i.assetId).sort();

    expect(await ids({ projectIds: [projectA] })).toEqual([uhd]);
    expect(await ids({ ownerUserIds: ['author-b'] })).toEqual([hd, portraitHd].sort());
    expect(await ids({ resolutions: ['4k'] })).toEqual([uhd]);
    // The short edge decides: 720×1280 is 720p.
    expect(await ids({ resolutions: ['1080p', '720p'] })).toEqual([hd, portraitHd].sort());
  });

  it('filters by usability: usable by default, unusable or all on request', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const projectId = await insertProject(folderId);
    const usable = await insertAsset();
    await insertAnalysis(usable, true, { usable: true });
    await linkAssetToProject(usable, projectId);
    const unusable = await insertAsset();
    await insertAnalysis(unusable, true, { usable: false });
    await linkAssetToProject(unusable, projectId);

    const ids = async (query: Parameters<FootageService['search']>[0]) =>
      (await footageService.search({ projectIds: [projectId], ...query }, userId, 'USER')).items
        .map((i) => i.assetId)
        .sort();

    expect(await ids({})).toEqual([usable]);
    expect(await ids({ usability: 'unusable' })).toEqual([unusable]);
    expect(await ids({ usability: 'all' })).toEqual([usable, unusable].sort());
    expect(await ids({ usableOnly: false })).toEqual([usable, unusable].sort());
    // `usability` wins over the older `usableOnly`.
    expect(await ids({ usableOnly: true, usability: 'unusable' })).toEqual([unusable]);
  });

  it('sorts by the chosen field and pages with a total', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const projectId = await insertProject(folderId);
    const short = await insertVideo(projectId, { width: 1280, height: 720, durationMs: 1_000 });
    const medium = await insertVideo(projectId, { width: 1280, height: 720, durationMs: 5_000 });
    const long = await insertVideo(projectId, { width: 1280, height: 720, durationMs: 9_000 });

    const first = await footageService.search(
      { sortBy: 'duration', sortOrder: 'asc', limit: 2, page: 1 },
      userId,
      'USER',
    );
    expect(first.items.map((i) => i.assetId)).toEqual([short, medium]);
    expect(first.total).toBe(3);

    const second = await footageService.search(
      { sortBy: 'duration', sortOrder: 'asc', limit: 2, page: 2 },
      userId,
      'USER',
    );
    expect(second.items.map((i) => i.assetId)).toEqual([long]);
    expect(second.total).toBe(3);
    expect(second.nextCursor).toBeNull();

    const desc = await footageService.search({ sortBy: 'duration' }, userId, 'USER');
    expect(desc.items.map((i) => i.assetId)).toEqual([long, medium, short]);
  });
});

describe('FootageService.search — sort by folder and project', () => {
  it('sorts by one visible project: first by folder path then name, or by name', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const root = await insertFolder();
    await grantFolder(root, userId);
    const folder9 = await insertFolder(root);
    const folder10 = await insertFolder(root);
    await ds.query(`UPDATE folders SET path_text = $2 WHERE id = $1`, [folder9, 'Root / Folder 9']);
    await ds.query(`UPDATE folders SET path_text = $2 WHERE id = $1`, [
      folder10,
      'Root / Folder 10',
    ]);
    const project = async (folderId: string, name: string) => {
      const id = await insertProject(folderId);
      await ds.query(`UPDATE projects SET name = $2 WHERE id = $1`, [id, name]);
      return id;
    };
    const alpha = await project(folder10, 'Alpha');
    const beta = await project(folder9, 'Beta');
    const gamma = await project(folder10, 'Gamma');
    const kappa = await project(folder9, 'Kappa');
    const zeta = await project(folder9, 'Zeta');
    const media = { width: 1280, height: 720, durationMs: 1_000 };
    const inAlpha = await insertVideo(alpha, media);
    const inBeta = await insertVideo(beta, media);
    const inKappa = await insertVideo(kappa, media);
    // In two projects: Gamma by name; by folder Zeta ("Folder 9"), not Gamma's name with
    // Zeta's folder.
    const inGammaAndZeta = await insertVideo(gamma, media);
    await linkAssetToProject(inGammaAndZeta, zeta);

    const search = (sortBy: 'folder' | 'project', sortOrder: 'asc' | 'desc') =>
      footageService.search({ sortBy, sortOrder }, userId, 'USER');
    const order = async (sortBy: 'folder' | 'project', sortOrder: 'asc' | 'desc') =>
      (await search(sortBy, sortOrder)).items.map((i) => i.assetId);

    expect(await order('project', 'asc')).toEqual([inAlpha, inBeta, inGammaAndZeta, inKappa]);
    expect(await order('project', 'desc')).toEqual([inKappa, inGammaAndZeta, inBeta, inAlpha]);
    // Natural order: "Folder 9" before "Folder 10"; projects by name within a folder.
    expect(await order('folder', 'asc')).toEqual([inBeta, inKappa, inGammaAndZeta, inAlpha]);
    expect(await order('folder', 'desc')).toEqual([inAlpha, inGammaAndZeta, inKappa, inBeta]);

    // A video lists its projects in the same order, the one it sorts by first.
    const dual = (await search('folder', 'asc')).items.find((i) => i.assetId === inGammaAndZeta);
    expect(dual).toMatchObject({
      projectIds: [zeta, gamma],
      projectNames: ['Zeta', 'Gamma'],
      folderIds: [folder9, folder10],
    });
  });
});

describe('FootageService.getFacets — projects, authors, resolutions', () => {
  it('counts each value, leaving out the facet’s own filter', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const projectA = await insertProject(folderId, { ownerUserId: 'author-a' });
    const projectB = await insertProject(folderId, { ownerUserId: 'author-b' });
    await insertVideo(projectA, { width: 3840, height: 2160, durationMs: 5_000 });
    await insertVideo(projectB, { width: 1920, height: 1080, durationMs: 9_000 });
    await insertVideo(projectB, { width: 1280, height: 720, durationMs: 1_000 });

    const facets = await footageService.getFacets({ projectIds: [projectA] }, userId, 'USER');

    // Picking project A keeps project B on offer…
    expect(facets.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: projectA, count: 1 }),
        expect.objectContaining({ value: projectB, count: 2 }),
      ]),
    );
    expect(facets.projects.find((f) => f.value === projectA)?.label).toMatch(/^Project /);
    // …while the other facets count project A only.
    expect(facets.authors).toEqual([{ value: 'author-a', label: 'author-a', count: 1 }]);
    expect(facets.resolutions).toEqual([{ value: '4k', count: 1 }]);
  });
});

describe('FootageService.getAssetMedia — detail', () => {
  it('returns the file metadata, visible projects and previews on offer', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertFolder();
    await grantFolder(folderId, userId);
    const visible = await insertProject(folderId, { ownerUserId: 'author-a' });
    const otherFolder = await insertFolder();
    const hidden = await insertProject(otherFolder);
    const assetId = await insertVideo(visible, { width: 1920, height: 1080, durationMs: 8_000 });
    await linkAssetToProject(assetId, hidden);
    await ds.query(
      `INSERT INTO asset_variants
         (id, asset_id, render_profile_id, variant_code, render_version,
          storage_provider, bucket_name, storage_key, mime_type, file_size_bytes,
          width, height, has_watermark, status)
       VALUES ($1,$2,null,'preview_720p_wm',1,'r2','ag-go','variants/720.mp4','video/mp4',1000000,1280,720,true,'ready'),
              ($3,$2,null,'preview_360p_wm',1,'r2','ag-go','variants/360.mp4','video/mp4',250000,640,360,true,'ready')`,
      [randomUUID(), assetId, randomUUID()],
    );

    const media = await footageService.getAssetMedia(assetId, userId, 'USER');

    expect(media.projects.map((p) => p.id)).toEqual([visible]);
    expect(media.projects[0]).toMatchObject({ ownerUserId: 'author-a', folderId });
    expect(media.file).toMatchObject({
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      width: 1920,
      height: 1080,
      durationMs: 8_000,
      frameRate: 25,
    });
    expect(media.variants.map((v) => v.variantCode)).toEqual([
      'preview_360p_wm',
      'preview_720p_wm',
    ]);
    expect(media.variants[1].bitrateBps).toBe(1_000_000);

    const url = await footageService.getPreviewUrl(assetId, 'preview_360p_wm', userId, 'USER');
    expect(url.url).toContain('variants/360.mp4');
    await expect(
      footageService.getPreviewUrl(assetId, 'original', userId, 'USER'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
