/**
 * DB-level integration tests for RenderService:
 * - listBatches (per-project batches with server paging & permission check)
 * - listAllBatches (cross-project batches with SQL join permission filtering & server paging)
 * - listJobs (jobs of a render batch with paging, status filter, search, sort and counts)
 * - listAutoJobs (auto render jobs with paging, project filter, folder scoping and counts)
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { AssetEntity } from '../../database/entities/asset.entity';
import { CategoryAccessGrantEntity } from '../../database/entities/category-access-grant.entity';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { FolderAccessService } from '../folders/folder-access.service';
import { RenderService } from './render.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
// The ESM build of uuid does not load under ts-jest; these tests create no ids with it.
jest.mock('uuid', () => ({ v7: () => '00000000-0000-7000-9000-000000000000' }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let renderService: RenderService;
let folderAccess: FolderAccessService;
let defaultProfileId: string;

const createdBatchIds: string[] = [];
const createdJobIds: string[] = [];
const createdProjectIds: string[] = [];
const createdAssetIds: string[] = [];
const createdFolderIds: string[] = [];

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;

  folderAccess = new FolderAccessService(
    ds.getRepository(FolderAccessGrantEntity),
    ds.getRepository(FolderClosureEntity),
    ds.getRepository(FolderEntity),
    ds.getRepository(CategoryAccessGrantEntity),
  );

  const actorEnrichment = {
    enrich: async <T extends Record<string, unknown>>(
      rows: T[],
      fields: Array<{ id: string; target: string }>,
    ) =>
      rows.map((row) => {
        const enriched: Record<string, unknown> = { ...row };
        for (const field of fields) {
          const id = row[field.id];
          enriched[field.target] = typeof id === 'string' ? { id, email: `${id}@test` } : null;
        }
        return enriched;
      }),
  };

  renderService = new RenderService(
    ds,
    ds.getRepository(RenderProfileEntity),
    ds.getRepository(RenderBatchEntity),
    ds.getRepository(MediaRenderJobEntity),
    ds.getRepository(ProjectEntity),
    ds.getRepository(ProjectMediaEntity),
    ds.getRepository(AssetEntity),
    folderAccess,
    { addProcessingJob: jest.fn() } as never,
    actorEnrichment as never,
    { getOrThrow: () => 1280 } as never,
  );

  // Use an existing active render profile or seed one with a unique code
  const existing = await ds
    .getRepository(RenderProfileEntity)
    .findOne({ where: { isActive: true } });
  if (existing) {
    defaultProfileId = existing.id;
  } else {
    defaultProfileId = randomUUID();
    await ds.query(
      `INSERT INTO render_profiles (id, name, code, profile_version, output_format, watermark_enabled, render_sizes)
       VALUES ($1, 'Test Profile', $2, 1, 'jpg', false, '{"variants":[{"resolution":720,"watermark":false}],"thumbnailWidth":320}')`,
      [defaultProfileId, `profile-${defaultProfileId.slice(0, 8)}`],
    );
  }
});

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

afterEach(async () => {
  if (createdJobIds.length) {
    await ds.query(`DELETE FROM media_render_jobs WHERE id = ANY($1)`, [createdJobIds]);
    createdJobIds.length = 0;
  }
  if (createdBatchIds.length) {
    await ds.query(`DELETE FROM render_batches WHERE id = ANY($1)`, [createdBatchIds]);
    createdBatchIds.length = 0;
  }
  if (createdProjectIds.length) {
    await ds.query(`DELETE FROM project_media WHERE project_id = ANY($1)`, [createdProjectIds]);
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
// Helpers
// ---------------------------------------------------------------------------

async function insertFolder(
  userId?: string,
  parentId?: string,
  inherit = true,
  accessLevel: 'viewer' | 'editor' | 'manager' = 'viewer',
): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, sort_order, is_active, created_by)
     VALUES ($1, $2, $3, $4, '{}', $5, 0, 0, true, 'test')`,
    [id, parentId ?? null, `Folder ${id.slice(0, 8)}`, `/${id}`, `Folder ${id.slice(0, 8)}`],
  );
  await ds.query(
    `INSERT INTO folder_closure (ancestor_id, descendant_id, depth) VALUES ($1, $1, 0)`,
    [id],
  );
  if (parentId) {
    await ds.query(
      `INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
       SELECT ancestor_id, $1, depth + 1 FROM folder_closure WHERE descendant_id = $2`,
      [id, parentId],
    );
  }
  if (userId) {
    await ds.query(
      `INSERT INTO folder_access_grants (id, folder_id, principal_type, principal_id, access_level, inherit_children)
       VALUES ($1, $2, 'user', $3, $4, $5)`,
      [randomUUID(), id, userId, accessLevel, inherit],
    );
  }
  createdFolderIds.push(id);
  return id;
}

async function insertProject(folderId: string, ownerUserId = 'owner-1'): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO projects (id, folder_id, name, evaluation_status, owner_user_id)
     VALUES ($1, $2, $3, 'pending', $4)`,
    [id, folderId, `Project ${id.slice(0, 8)}`, ownerUserId],
  );
  createdProjectIds.push(id);
  return id;
}

async function insertAsset(filename = 'photo.jpg'): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO assets (id, original_storage_key, original_bucket, original_filename, file_size_bytes, mime_type, asset_type, created_by)
     VALUES ($1, $2, 'test-bucket', $3, 1024, 'image/jpeg', 'image', 'test')`,
    [id, `assets/${id}.jpg`, filename],
  );
  createdAssetIds.push(id);
  return id;
}

async function insertProjectMedia(projectId: string, assetId: string): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO project_media (id, project_id, asset_id, sort_order, created_by)
     VALUES ($1, $2, $3, 0, 'test')`,
    [id, projectId, assetId],
  );
  return id;
}

async function insertBatch(options: {
  projectId?: string | null;
  folderId?: string | null;
  status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  totalJobs?: number;
  completedJobs?: number;
  createdBy?: string;
}): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO render_batches (id, project_id, folder_id, render_profile_id, status, total_jobs, completed_jobs, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      options.projectId ?? null,
      options.folderId ?? null,
      defaultProfileId,
      options.status ?? 'queued',
      options.totalJobs ?? 1,
      options.completedJobs ?? 0,
      options.createdBy ?? 'test',
    ],
  );
  createdBatchIds.push(id);
  return id;
}

async function insertJob(options: {
  assetId: string;
  renderBatchId?: string | null;
  status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  createdBy?: string;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO media_render_jobs (id, asset_id, render_profile_id, render_batch_id, dedupe_key, status, created_by, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      options.assetId,
      defaultProfileId,
      options.renderBatchId ?? null,
      `dedupe:${id}`,
      options.status ?? 'queued',
      options.createdBy ?? 'test',
      options.startedAt ?? null,
      options.finishedAt ?? null,
    ],
  );
  createdJobIds.push(id);
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RenderService DB specs', () => {
  describe('listBatches (project render batches)', () => {
    it('returns paged batches for a specific project', async () => {
      const folderId = await insertFolder('user-1');
      const projectId = await insertProject(folderId);

      await insertBatch({ projectId, status: 'completed' });
      await insertBatch({ projectId, status: 'processing' });
      await insertBatch({ projectId, status: 'failed' });

      // Another project's batch
      const otherProject = await insertProject(folderId);
      await insertBatch({ projectId: otherProject });

      const result = await renderService.listBatches(projectId, 'user-1', 'USER', {
        page: 1,
        pageSize: 2,
      });

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(2);
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(2);
      expect(result.counts.all).toBe(3);
      expect(result.counts.active).toBe(1);
      expect(result.counts.completed).toBe(1);
      expect(result.counts.failed).toBe(1);
    });

    it('filters batches by status in a project', async () => {
      const folderId = await insertFolder('user-1');
      const projectId = await insertProject(folderId);

      await insertBatch({ projectId, status: 'completed' });
      await insertBatch({ projectId, status: 'processing' });

      const activeResult = await renderService.listBatches(projectId, 'user-1', 'USER', {
        status: 'active',
      });
      expect(activeResult.items).toHaveLength(1);
      expect(activeResult.items[0]?.status).toBe('processing');
      expect(activeResult.total).toBe(1);
      expect(activeResult.counts.all).toBe(2);
      expect(activeResult.counts.active).toBe(1);
    });

    it('throws ForbiddenException if user has no access to project', async () => {
      const folderId = await insertFolder('user-1');
      const projectId = await insertProject(folderId);

      await expect(renderService.listBatches(projectId, 'other-user', 'USER')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('allows admin to list batches regardless of folder grant', async () => {
      const folderId = await insertFolder();
      const projectId = await insertProject(folderId);
      await insertBatch({ projectId });

      const result = await renderService.listBatches(projectId, 'admin-1', 'ADMIN');
      expect(result.total).toBe(1);
    });
  });

  describe('listAllBatches (cross-project batches)', () => {
    it('admin sees all batches across all projects and folders', async () => {
      const folder1 = await insertFolder();
      const folder2 = await insertFolder();
      const proj1 = await insertProject(folder1);
      const proj2 = await insertProject(folder2);

      await insertBatch({ projectId: proj1 });
      await insertBatch({ projectId: proj2 });
      await insertBatch({ folderId: folder1 });

      const result = await renderService.listAllBatches('admin-1', 'ADMIN', { pageSize: 50 });
      expect(result.total).toBeGreaterThanOrEqual(3);
    });

    it('regular user only sees batches for accessible projects and folders via SQL join', async () => {
      const alice = 'alice-' + randomUUID().slice(0, 8);
      const bob = 'bob-' + randomUUID().slice(0, 8);

      const aliceFolder = await insertFolder(alice);
      const bobFolder = await insertFolder(bob);

      const aliceProj = await insertProject(aliceFolder);
      const bobProj = await insertProject(bobFolder);

      const batchAliceProj = await insertBatch({ projectId: aliceProj, status: 'completed' });
      const batchAliceFolder = await insertBatch({ folderId: aliceFolder, status: 'processing' });
      const batchBobProj = await insertBatch({ projectId: bobProj, status: 'completed' });
      const batchBobFolder = await insertBatch({ folderId: bobFolder, status: 'failed' });

      const result = await renderService.listAllBatches(alice, 'USER');
      const returnedIds = result.items.map((b) => b.id);

      expect(returnedIds).toContain(batchAliceProj);
      expect(returnedIds).toContain(batchAliceFolder);
      expect(returnedIds).not.toContain(batchBobProj);
      expect(returnedIds).not.toContain(batchBobFolder);
      expect(result.total).toBe(2);
      expect(result.counts.all).toBe(2);
      expect(result.counts.active).toBe(1);
      expect(result.counts.completed).toBe(1);
    });

    it('regular user inherits access to subfolder project batches', async () => {
      const user = 'sub-user-' + randomUUID().slice(0, 8);
      const parentFolder = await insertFolder(user, undefined, true);
      const subFolder = await insertFolder(undefined, parentFolder);
      const subProj = await insertProject(subFolder);

      const subBatch = await insertBatch({ projectId: subProj });

      const result = await renderService.listAllBatches(user, 'USER');
      expect(result.items.map((b) => b.id)).toContain(subBatch);
    });

    it('pages cross-project batches with pageBounds', async () => {
      const user = 'page-user-' + randomUUID().slice(0, 8);
      const folder = await insertFolder(user);
      const proj = await insertProject(folder);

      for (let i = 0; i < 5; i++) {
        await insertBatch({ projectId: proj });
      }

      const p1 = await renderService.listAllBatches(user, 'USER', { page: 1, pageSize: 2 });
      expect(p1.items).toHaveLength(2);
      expect(p1.total).toBe(5);
      expect(p1.page).toBe(1);
      expect(p1.pageSize).toBe(2);

      const p2 = await renderService.listAllBatches(user, 'USER', { page: 2, pageSize: 2 });
      expect(p2.items).toHaveLength(2);
      expect(p2.page).toBe(2);
      expect(p2.items[0]?.id).not.toBe(p1.items[0]?.id);
    });
  });

  describe('listJobs (batch render jobs)', () => {
    it('returns paged jobs of a batch with status filtering and counts', async () => {
      const folder = await insertFolder('user-1', undefined, true, 'manager');
      const proj = await insertProject(folder);
      const batchId = await insertBatch({ projectId: proj });

      const a1 = await insertAsset('beach.jpg');
      const a2 = await insertAsset('mountain.jpg');
      const a3 = await insertAsset('forest.jpg');

      await insertProjectMedia(proj, a1);
      await insertProjectMedia(proj, a2);
      await insertProjectMedia(proj, a3);

      await insertJob({ assetId: a1, renderBatchId: batchId, status: 'completed' });
      await insertJob({ assetId: a2, renderBatchId: batchId, status: 'processing' });
      await insertJob({ assetId: a3, renderBatchId: batchId, status: 'failed' });

      const result = await renderService.listJobs(batchId, 'user-1', 'USER', {
        page: 1,
        pageSize: 2,
      });

      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(2);
      expect(result.counts.all).toBe(3);
      expect(result.counts.active).toBe(1);
      expect(result.counts.completed).toBe(1);
      expect(result.counts.failed).toBe(1);
    });

    it('searches batch jobs by asset original filename', async () => {
      const folder = await insertFolder('user-1', undefined, true, 'manager');
      const proj = await insertProject(folder);
      const batchId = await insertBatch({ projectId: proj });

      const a1 = await insertAsset('sunset-in-da-nang.jpg');
      const a2 = await insertAsset('hanoi-street.jpg');
      await insertProjectMedia(proj, a1);
      await insertProjectMedia(proj, a2);

      await insertJob({ assetId: a1, renderBatchId: batchId });
      await insertJob({ assetId: a2, renderBatchId: batchId });

      const searchResult = await renderService.listJobs(batchId, 'user-1', 'USER', {
        search: 'da-nang',
      });
      expect(searchResult.total).toBe(1);
      const firstItem = searchResult.items[0] as
        Record<string, Record<string, unknown>> | undefined;
      expect(firstItem?.asset?.originalFilename).toBe('sunset-in-da-nang.jpg');
    });

    it('throws NotFoundException for non-existent batch', async () => {
      await expect(renderService.listJobs(randomUUID(), 'user-1', 'USER')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listAutoJobs (jobs outside batches)', () => {
    it('returns auto jobs paged and filtered by status and counts', async () => {
      const folder = await insertFolder('user-1');
      const proj = await insertProject(folder);

      const a1 = await insertAsset('auto1.jpg');
      const a2 = await insertAsset('auto2.jpg');
      await insertProjectMedia(proj, a1);
      await insertProjectMedia(proj, a2);

      // Auto jobs have renderBatchId: null
      await insertJob({ assetId: a1, renderBatchId: null, status: 'queued' });
      await insertJob({ assetId: a2, renderBatchId: null, status: 'completed' });

      // Batch job should not appear in auto jobs
      const batchId = await insertBatch({ projectId: proj });
      await insertJob({ assetId: a1, renderBatchId: batchId, status: 'queued' });

      const result = await renderService.listAutoJobs('user-1', 'USER', {
        projectId: proj,
      });

      expect(result.total).toBe(2);
      expect(result.counts.all).toBe(2);
      expect(result.counts.active).toBe(1);
      expect(result.counts.completed).toBe(1);
    });

    it('scopes auto jobs to accessible folders for normal users', async () => {
      const alice = 'alice-auto-' + randomUUID().slice(0, 8);
      const bob = 'bob-auto-' + randomUUID().slice(0, 8);

      const aliceFolder = await insertFolder(alice);
      const bobFolder = await insertFolder(bob);

      const aliceProj = await insertProject(aliceFolder);
      const bobProj = await insertProject(bobFolder);

      const aAlice = await insertAsset('alice-asset.jpg');
      const aBob = await insertAsset('bob-asset.jpg');
      await insertProjectMedia(aliceProj, aAlice);
      await insertProjectMedia(bobProj, aBob);

      const jobAlice = await insertJob({ assetId: aAlice, renderBatchId: null });
      const jobBob = await insertJob({ assetId: aBob, renderBatchId: null });

      const aliceResult = await renderService.listAutoJobs(alice, 'USER');
      const aliceJobIds = aliceResult.items.map((j) => j.id);

      expect(aliceJobIds).toContain(jobAlice);
      expect(aliceJobIds).not.toContain(jobBob);
    });
  });
});
