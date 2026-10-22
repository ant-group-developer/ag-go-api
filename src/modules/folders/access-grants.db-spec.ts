/**
 * DB-level tests of who reaches which project: work grants (`access_grants`, folder × category)
 * and originals bundles (`original_access_bundles`, folders × categories), and how both are
 * managed. Runs against real Postgres (see footage.db-spec.ts for the setup).
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
import { OriginalAccessBundleEntity } from '../../database/entities/original-access-bundle.entity';
import { AccessGrantsService, type GrantRequester } from './access-grants.service';
import { FolderAccessService } from './folder-access.service';
import { OriginalAccessService } from './original-access.service';

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
let originals: OriginalAccessService;
const folderIds: string[] = [];
const categoryIds: string[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  const enrichment = { enrich: async <T>(rows: T[]) => rows } as never;
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
    enrichment,
  );
  originals = new OriginalAccessService(
    ds,
    ds.getRepository(OriginalAccessBundleEntity),
    ds.getRepository(FolderEntity),
    ds.getRepository(CategoryEntity),
    enrichment,
    access,
  );
});

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

afterEach(async () => {
  await ds.query(`DELETE FROM original_access_bundles WHERE principal_id = ANY($1)`, [userIds]);
  await ds.query(`DELETE FROM access_grants WHERE folder_id = ANY($1) OR category_id = ANY($2)`, [
    folderIds,
    categoryIds,
  ]);
  await ds.query(`DELETE FROM folder_closure WHERE descendant_id = ANY($1)`, [folderIds]);
  await ds.query(`DELETE FROM folders WHERE id = ANY($1)`, [folderIds]);
  await ds.query(`DELETE FROM categories WHERE id = ANY($1)`, [categoryIds]);
  folderIds.length = 0;
  categoryIds.length = 0;
  userIds.length = 0;
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
  folderId: string,
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

const user = () => {
  const id = `u-${randomUUID().slice(0, 8)}`;
  userIds.push(id);
  return id;
};
const project = (
  folderId: string,
  categoryId: string | null,
  evaluationStatus: 'pending' | 'completed' = 'completed',
) => ({ folderId, categoryId, evaluationStatus, ownerUserId: 'someone-else' });
const admin: GrantRequester = { userId: 'admin', userType: 'ADMIN' };
const asUser = (userId: string): GrantRequester => ({
  userId,
  userType: 'USER',
  permissions: [GO_PERMISSIONS.CATEGORY_ACCESS_MANAGE],
});

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

  it('lists evaluated projects for read_all, bundles and work grants only', async () => {
    const userId = user();
    const folder = await insertFolder();
    const category = await insertCategory();
    const evaluated = project(folder, category);

    // No grant, no read_all: not even watermarked.
    await expect(access.canViewProject(evaluated, userId, 'USER', undefined, [])).resolves.toBe(
      false,
    );
    await expect(
      access.canViewProject(evaluated, userId, 'USER', undefined, [
        GO_PERMISSIONS.PROJECT_READ_ALL,
      ]),
    ).resolves.toBe(true);
    await expect(
      access.canViewProject({ ...evaluated, ownerUserId: userId }, userId, 'USER', undefined, []),
    ).resolves.toBe(true);

    await originals.create(
      { principalId: userId, folderIds: [folder], categoryIds: [category] },
      admin,
    );
    await expect(access.canViewProject(evaluated, userId, 'USER', undefined, [])).resolves.toBe(
      true,
    );
    // Bundles only reach evaluated projects.
    await expect(
      access.canViewProject(project(folder, category, 'pending'), userId, 'USER', undefined, []),
    ).resolves.toBe(false);
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

describe('OriginalAccessService', () => {
  it('lets a team lead hand on part of their reach, and nothing beyond it', async () => {
    const lan = user();
    const minh = user();
    const hanoi = await insertFolder();
    const hoanKiem = await insertFolder(hanoi);
    const hue = await insertFolder();
    const amThuc = await insertCategory();
    const bienDao = await insertCategory();
    // The footage manager (an admin here) gives Lan Ẩm thực in Hà Nội and Huế.
    await originals.create(
      { principalId: lan, folderIds: [hanoi, hue], categoryIds: [amThuc] },
      admin,
    );

    await originals.create(
      { principalId: minh, folderIds: [hanoi], categoryIds: [amThuc] },
      asUser(lan),
    );
    await expect(access.canSeeOriginals(project(hoanKiem, amThuc), minh)).resolves.toBe(true);
    await expect(access.canSeeOriginals(project(hue, amThuc), minh)).resolves.toBe(false);

    const preview = await originals.preview(
      { folderIds: [hanoi], categoryIds: [amThuc, bienDao] },
      asUser(lan),
    );
    expect(preview.invalidCount).toBe(1);
    expect(preview.invalidPairs[0]).toMatchObject({
      folder: { id: hanoi },
      category: { id: bienDao },
    });
    await expect(
      originals.create(
        { principalId: minh, folderIds: [hanoi], categoryIds: [bienDao] },
        asUser(lan),
      ),
    ).rejects.toThrow('out of your reach');
  });

  it('adds bundles from several granters up without mixing them', async () => {
    const minh = user();
    const hanoi = await insertFolder();
    const hue = await insertFolder();
    const amThuc = await insertCategory();
    const vanHoa = await insertCategory();
    await originals.create({ principalId: minh, folderIds: [hanoi], categoryIds: [amThuc] }, admin);
    await originals.create({ principalId: minh, folderIds: [hue], categoryIds: [vanHoa] }, admin);

    await expect(access.canSeeOriginals(project(hanoi, amThuc), minh)).resolves.toBe(true);
    await expect(access.canSeeOriginals(project(hue, vanHoa), minh)).resolves.toBe(true);
    await expect(access.canSeeOriginals(project(hanoi, vanHoa), minh)).resolves.toBe(false);
    await expect(access.canSeeOriginals(project(hue, amThuc), minh)).resolves.toBe(false);
  });

  it('keeps a bundle when its granter loses their reach', async () => {
    const lan = user();
    const minh = user();
    const folder = await insertFolder();
    const category = await insertCategory();
    const lansBundle = await originals.create(
      { principalId: lan, folderIds: [folder], categoryIds: [category] },
      admin,
    );
    await originals.create(
      { principalId: minh, folderIds: [folder], categoryIds: [category] },
      asUser(lan),
    );

    await originals.remove(lansBundle.id, admin);

    await expect(access.canSeeOriginals(project(folder, category), minh)).resolves.toBe(true);
    await expect(access.canSeeOriginals(project(folder, category), lan)).resolves.toBe(false);
  });

  it('lets only its granter or an admin change a bundle', async () => {
    const lan = user();
    const hung = user();
    const folder = await insertFolder();
    const category = await insertCategory();
    for (const lead of [lan, hung]) {
      await originals.create(
        { principalId: lead, folderIds: [folder], categoryIds: [category] },
        admin,
      );
    }
    const minhs = await originals.create(
      { principalId: user(), folderIds: [folder], categoryIds: [category] },
      asUser(lan),
    );

    await expect(originals.remove(minhs.id, asUser(hung))).rejects.toThrow(
      'Only its granter or an admin can change this bundle',
    );
    const [seenByHung] = await originals.userBundles(minhs.principalId, asUser(hung));
    expect(seenByHung.canEdit).toBe(false);
    await originals.remove(minhs.id, asUser(lan));
  });

  it('needs both lists, keeps the top folders and covers subfolders made later', async () => {
    const minh = user();
    const hanoi = await insertFolder();
    const hoanKiem = await insertFolder(hanoi);
    const category = await insertCategory();

    await expect(
      originals.create({ principalId: minh, folderIds: [hanoi], categoryIds: [] }, admin),
    ).rejects.toThrow('Pick at least one folder and one category');
    const bundle = await originals.create(
      { principalId: minh, folderIds: [hanoi, hoanKiem], categoryIds: [category] },
      admin,
    );
    expect(bundle.folders.map((folder) => folder.id)).toEqual([hanoi]);

    const tayHo = await insertFolder(hanoi);
    await expect(access.canSeeOriginals(project(tayHo, category), minh)).resolves.toBe(true);
  });

  it('counts inherited work grants in the reach of a folder manager', async () => {
    const manager = user();
    const folder = await insertFolder();
    const child = await insertFolder(folder);
    const category = await insertCategory();
    await grant(manager, folder, null, 'manager');

    const reach = await originals.reach(asUser(manager));
    expect(reach.folderIds?.sort()).toEqual([folder, child].sort());
    expect(reach.categoryIds).toContain(category);
    await originals.create(
      { principalId: user(), folderIds: [child], categoryIds: [category] },
      asUser(manager),
    );
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

  it('keeps manager grants on every category', async () => {
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
