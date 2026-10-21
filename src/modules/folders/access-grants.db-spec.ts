/**
 * DB-level tests of `access_grants`: who reaches which project (folder × category) and how grants
 * are managed. Runs against real Postgres (see footage.db-spec.ts for the setup).
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { AppDataSource } from '../../database/data-source';
import { AccessGrantEntity } from '../../database/entities/access-grant.entity';
import { CategoryEntity } from '../../database/entities/category.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { AccessGrantsService } from './access-grants.service';
import { FolderAccessService } from './folder-access.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
// The ESM build of uuid does not load under ts-jest.
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let access: FolderAccessService;
let grants: AccessGrantsService;
const folderIds: string[] = [];
const categoryIds: string[] = [];

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  access = new FolderAccessService(
    ds.getRepository(AccessGrantEntity),
    ds.getRepository(FolderEntity),
  );
  grants = new AccessGrantsService(
    ds,
    ds.getRepository(AccessGrantEntity),
    ds.getRepository(FolderEntity),
    ds.getRepository(CategoryEntity),
    ds.getRepository(FolderClosureEntity),
    access,
    { enrich: async <T>(rows: T[]) => rows } as never,
  );
});

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

afterEach(async () => {
  await ds.query(`DELETE FROM access_grants WHERE folder_id = ANY($1) OR category_id = ANY($2)`, [
    folderIds,
    categoryIds,
  ]);
  await ds.query(`DELETE FROM folder_closure WHERE descendant_id = ANY($1)`, [folderIds]);
  await ds.query(`DELETE FROM folders WHERE id = ANY($1)`, [folderIds]);
  await ds.query(`DELETE FROM categories WHERE id = ANY($1)`, [categoryIds]);
  folderIds.length = 0;
  categoryIds.length = 0;
});

/** A folder under `parentId` (closure rows included). */
async function insertFolder(parentId?: string): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, sort_order, is_active, created_by)
     VALUES ($1, $2, $3, $4, '{}', $5, 0, 0, true, 'test')`,
    [id, parentId ?? null, `Folder ${id.slice(0, 8)}`, `/${id}`, `Folder ${id.slice(0, 8)}`],
  );
  await ds.query(
    `INSERT INTO folder_closure (ancestor_id, descendant_id, depth)
     SELECT ancestor_id, $1::uuid, depth + 1 FROM folder_closure WHERE descendant_id = $2::uuid
     UNION ALL SELECT $1::uuid, $1::uuid, 0`,
    [id, parentId ?? null],
  );
  folderIds.push(id);
  return id;
}

async function insertCategory(): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO categories (id, name, slug, sort_order, is_active) VALUES ($1, $2, $3, 0, true)`,
    [id, `Category ${id.slice(0, 8)}`, `category-${id}`],
  );
  categoryIds.push(id);
  return id;
}

async function grant(
  userId: string,
  folderId: string | null,
  categoryId: string | null,
  level: string,
  inheritChildren = true,
) {
  await ds.query(
    `INSERT INTO access_grants (id, principal_type, principal_id, folder_id, category_id, access_level, inherit_children)
     VALUES ($1, 'user', $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, folderId, categoryId, level, inheritChildren],
  );
}

const user = () => `u-${randomUUID().slice(0, 8)}`;
const project = (
  folderId: string,
  categoryId: string | null,
  evaluationStatus: 'pending' | 'completed' = 'pending',
) => ({ folderId, categoryId, evaluationStatus, ownerUserId: 'someone-else' });

describe('FolderAccessService', () => {
  it('limits a folder grant to its category, through inherited subfolders', async () => {
    const userId = user();
    const root = await insertFolder();
    const child = await insertFolder(root);
    const granted = await insertCategory();
    const other = await insertCategory();
    await grant(userId, root, granted, 'editor');

    await expect(access.canAccessProject(project(child, granted), userId, 'editor')).resolves.toBe(
      true,
    );
    await expect(access.canAccessProject(project(child, other), userId, 'viewer')).resolves.toBe(
      false,
    );
    await expect(access.canAccessProject(project(child, null), userId, 'viewer')).resolves.toBe(
      false,
    );
    // The folder itself (subfolders, moves, grants) needs a grant on every category.
    await expect(access.canAccess(root, userId, 'viewer')).resolves.toBe(false);
  });

  it('does not inherit a grant when inherit_children is false', async () => {
    const userId = user();
    const root = await insertFolder();
    const child = await insertFolder(root);
    await grant(userId, root, null, 'manager', false);

    await expect(access.canAccess(root, userId, 'manager')).resolves.toBe(true);
    await expect(access.canAccess(child, userId, 'viewer')).resolves.toBe(false);
  });

  it('takes the highest level of the grants reaching a project', async () => {
    const userId = user();
    const folder = await insertFolder();
    const category = await insertCategory();
    await grant(userId, folder, null, 'viewer');
    await grant(userId, folder, category, 'editor');

    await expect(access.projectLevel(project(folder, category), userId)).resolves.toBe('editor');
    await expect(access.projectLevel(project(folder, null), userId)).resolves.toBe('viewer');
  });

  it('lets an original grant reach evaluated projects only, in every folder', async () => {
    const userId = user();
    const folder = await insertFolder();
    const category = await insertCategory();
    await grant(userId, null, category, 'original');

    await expect(
      access.canSeeOriginals(project(folder, category, 'completed'), userId),
    ).resolves.toBe(true);
    await expect(
      access.canSeeOriginals(project(folder, category, 'pending'), userId),
    ).resolves.toBe(false);
    await expect(
      access.canAccessProject(project(folder, category, 'completed'), userId, 'viewer'),
    ).resolves.toBe(false);
  });

  it('opens evaluated projects to everyone and the others to viewer grants', async () => {
    const userId = user();
    const folder = await insertFolder();
    const category = await insertCategory();

    await expect(
      access.canViewProject(project(folder, category, 'completed'), userId),
    ).resolves.toBe(true);
    await expect(access.canViewProject(project(folder, category), userId)).resolves.toBe(false);
    await expect(
      access.canViewProject({ ...project(folder, category), ownerUserId: userId }, userId),
    ).resolves.toBe(true);
  });

  it('describes the folders reached, telling category-limited ones apart', async () => {
    const userId = user();
    const full = await insertFolder();
    const limited = await insertFolder();
    const category = await insertCategory();
    await grant(userId, full, null, 'manager');
    await grant(userId, limited, category, 'editor');

    const levels = await access.folderLevels(userId);

    expect(levels.get(full)).toEqual({ level: 'manager', projectLevel: 'manager' });
    expect(levels.get(limited)).toEqual({ level: null, projectLevel: 'editor' });
    expect((await access.accessibleFolderIds(userId)).sort()).toEqual([full, limited].sort());
    expect(await access.managedFolderIds(userId)).toEqual([full]);
  });
});

describe('AccessGrantsService', () => {
  const folderManager = (userId: string) => ({
    userId,
    userType: 'USER' as const,
    permissions: [GO_PERMISSIONS.FOLDER_MANAGE],
  });

  it('grants a folder for each picked category, updating one granted already', async () => {
    const managerId = user();
    const target = user();
    const folder = await insertFolder();
    const first = await insertCategory();
    const second = await insertCategory();
    await grant(managerId, folder, null, 'manager');
    await grant(target, folder, first, 'viewer');

    const created = await grants.create(
      {
        principalId: target,
        folderId: folder,
        categoryIds: [first, second],
        accessLevel: 'editor',
      },
      folderManager(managerId),
    );

    expect(created.map((row) => [row.category?.id, row.accessLevel]).sort()).toEqual(
      [
        [first, 'editor'],
        [second, 'editor'],
      ].sort(),
    );
    const userGrants = await grants.userGrants(target, folderManager(managerId));
    expect(userGrants).toHaveLength(2);
  });

  it('keeps manager grants on every category and every-folder grants at original', async () => {
    const managerId = user();
    const folder = await insertFolder();
    const category = await insertCategory();
    await grant(managerId, folder, null, 'manager');

    await expect(
      grants.create(
        { principalId: user(), folderId: folder, categoryIds: [category], accessLevel: 'manager' },
        folderManager(managerId),
      ),
    ).rejects.toThrow('Manager access covers every category');
    await expect(
      grants.create(
        { principalId: user(), folderId: null, categoryIds: [category], accessLevel: 'viewer' },
        { userId: 'admin', userType: 'ADMIN' },
      ),
    ).rejects.toThrow('Only the original level can cover every folder');
  });

  it('leaves grants on every folder to category access managers', async () => {
    const managerId = user();
    const category = await insertCategory();
    await grant(managerId, await insertFolder(), null, 'manager');
    const dto = {
      principalId: user(),
      folderId: null,
      categoryIds: [category],
      accessLevel: 'original' as const,
    };

    await expect(grants.create(dto, folderManager(managerId))).rejects.toThrow(
      'Grants on every folder need category access management',
    );
    const created = await grants.create(dto, {
      userId: managerId,
      userType: 'USER',
      permissions: [GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE],
    });
    expect(created[0]).toMatchObject({ folderId: null, categoryId: category });
  });

  it('does not let a folder manager drop their own manager access', async () => {
    const managerId = user();
    const folder = await insertFolder();
    await grant(managerId, folder, null, 'manager');
    const [own] = await grants.folderGrants(folder, folderManager(managerId)).then((r) => r.direct);

    await expect(
      grants.update(own.id, { accessLevel: 'editor' }, folderManager(managerId)),
    ).rejects.toThrow('You cannot remove your own manager access to this folder');
  });
});
