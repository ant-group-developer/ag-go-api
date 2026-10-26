/**
 * DB-level tests of the project list's author (owner) filter and the owners lookup.
 * Runs against real Postgres (see footage.db-spec.ts for the setup).
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { runInRequestContext } from '../../common/request-context';
import { AppDataSource } from '../../database/data-source';
import { AccessGrantEntity } from '../../database/entities/access-grant.entity';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { TagEntity } from '../../database/entities/tag.entity';
import { FolderAccessService } from '../folders/folder-access.service';
import { ListProjectsQueryDto } from './dto/list-projects-query.dto';
import { ProjectsService } from './projects.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
// The ESM build of uuid does not load under ts-jest; these tests create no ids with it.
jest.mock('uuid', () => ({ v7: () => '00000000-0000-7000-9000-000000000000' }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let service: ProjectsService;
const createdFolderIds: string[] = [];
const createdProjectIds: string[] = [];

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  const folderAccess = new FolderAccessService(
    ds.getRepository(AccessGrantEntity),
    ds.getRepository(FolderEntity),
  );
  // Users the account service knows: their id with an "@test" email.
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
  service = new ProjectsService(
    ds,
    ds.getRepository(ProjectEntity),
    ds.getRepository(FolderEntity),
    ds.getRepository(CategoryEntity),
    ds.getRepository(CountryEntity),
    ds.getRepository(ProvinceEntity),
    ds.getRepository(TagEntity),
    folderAccess,
    actorEnrichment as never,
    {} as never,
    {} as never,
  );
});

afterAll(async () => {
  if (ds?.isInitialized) await ds.destroy();
});

afterEach(async () => {
  if (createdProjectIds.length) {
    await ds.query(`DELETE FROM projects WHERE id = ANY($1)`, [createdProjectIds]);
    createdProjectIds.length = 0;
  }
  if (createdFolderIds.length) {
    await ds.query(`DELETE FROM access_grants WHERE folder_id = ANY($1)`, [createdFolderIds]);
    await ds.query(`DELETE FROM folder_closure WHERE descendant_id = ANY($1)`, [createdFolderIds]);
    await ds.query(`DELETE FROM folders WHERE id = ANY($1)`, [createdFolderIds]);
    createdFolderIds.length = 0;
  }
});

async function insertGrantedFolder(
  userId: string,
  options: { categoryId?: string; level?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, sort_order, is_active, created_by)
     VALUES ($1, NULL, $2, $3, '{}', $4, 0, 0, true, 'test')`,
    [id, `Folder ${id.slice(0, 8)}`, `/${id}`, `Folder ${id.slice(0, 8)}`],
  );
  await ds.query(
    `INSERT INTO folder_closure (ancestor_id, descendant_id, depth) VALUES ($1,$1,0)`,
    [id],
  );
  await ds.query(
    `INSERT INTO access_grants (id, folder_id, category_id, principal_type, principal_id, access_level, inherit_children)
     VALUES ($1,$2,$3,'user',$4,$5,true)`,
    [randomUUID(), id, options.categoryId ?? null, userId, options.level ?? 'viewer'],
  );
  createdFolderIds.push(id);
  return id;
}

async function insertProject(
  folderId: string,
  ownerUserId: string,
  evaluationStatus = 'pending',
): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO projects (id, owner_user_id, folder_id, name, evaluation_status)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, ownerUserId, folderId, `Project ${id.slice(0, 8)}`, evaluationStatus],
  );
  createdProjectIds.push(id);
  return id;
}

function listQuery(values: Partial<ListProjectsQueryDto>): ListProjectsQueryDto {
  return Object.assign(new ListProjectsQueryDto(), { page: 1, pageSize: 50 }, values);
}

describe('ProjectsService — author filter', () => {
  it('lists only the projects of the chosen owners', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    const byA = await insertProject(folderId, 'author-a');
    const byB = await insertProject(folderId, 'author-b');
    await insertProject(folderId, 'author-c');

    const result = await service.list(
      listQuery({ ownerUserIds: ['author-a', 'author-b'] }),
      userId,
      'USER',
    );

    expect(result.items.map((p) => (p as unknown as { id: string }).id).sort()).toEqual(
      [byA, byB].sort(),
    );
  });

  it('offers the owners of visible projects with their project counts', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    await insertProject(folderId, 'author-a');
    await insertProject(folderId, 'author-a');
    await insertProject(folderId, 'author-b');
    // Another user's draft is not listed, so its owner is not offered.
    await insertProject(folderId, 'author-draft', 'draft');

    const owners = await service.owners(undefined, userId, 'USER');

    expect(owners.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'author-a', projectCount: 2, user: { id: 'author-a', email: 'author-a@test' } },
      { id: 'author-b', projectCount: 1, user: { id: 'author-b', email: 'author-b@test' } },
    ]);
  });
});

describe('ProjectsService — page scopes', () => {
  const createdCategoryIds: string[] = [];
  const createdBundleIds: string[] = [];

  afterEach(async () => {
    if (createdBundleIds.length) {
      await ds.query(`DELETE FROM original_access_bundles WHERE id = ANY($1)`, [createdBundleIds]);
      createdBundleIds.length = 0;
    }
    if (createdCategoryIds.length) {
      await ds.query(`DELETE FROM access_grants WHERE category_id = ANY($1)`, [createdCategoryIds]);
      await ds.query(`DELETE FROM projects WHERE category_id = ANY($1)`, [createdCategoryIds]);
      await ds.query(`DELETE FROM categories WHERE id = ANY($1)`, [createdCategoryIds]);
      createdCategoryIds.length = 0;
    }
  });

  async function insertCategory(): Promise<string> {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO categories (id, name, slug, sort_order, is_active) VALUES ($1, $2, $3, 0, true)`,
      [id, `Category ${id.slice(0, 8)}`, `category-${id}`],
    );
    createdCategoryIds.push(id);
    return id;
  }

  /** A bundle of originals: the folders × the categories. */
  async function insertBundle(userId: string, folderIds: string[], categoryIds: string[]) {
    const id = randomUUID();
    await ds.query(
      `INSERT INTO original_access_bundles (id, principal_type, principal_id) VALUES ($1, 'user', $2)`,
      [id, userId],
    );
    await ds.query(
      `INSERT INTO original_access_bundle_folders (bundle_id, folder_id) SELECT $1, unnest($2::uuid[])`,
      [id, folderIds],
    );
    await ds.query(
      `INSERT INTO original_access_bundle_categories (bundle_id, category_id)
       SELECT $1, unnest($2::uuid[])`,
      [id, categoryIds],
    );
    createdBundleIds.push(id);
  }

  async function categorizedProject(folderId: string, categoryId: string, status: string) {
    const id = await insertProject(folderId, 'author-a', status);
    await ds.query(`UPDATE projects SET category_id = $2 WHERE id = $1`, [id, categoryId]);
    return id;
  }

  /** Runs `work` as a request of a user holding `permissions`. */
  function withPermissions<T>(permissions: string[], work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      runInRequestContext({ authContext: { permissions } } as never, () => {
        work().then(resolve, reject);
      }),
    );
  }

  async function listIds(
    scope: ListProjectsQueryDto['scope'],
    userId: string,
    permissions: string[] = [],
  ) {
    return withPermissions(permissions, async () =>
      (await service.list(listQuery({ scope }), userId, 'USER')).items
        .map((p) => (p as unknown as { id: string }).id)
        .sort(),
    );
  }

  it('lists every evaluated project on "Projects" with go.project.read_all', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(`other-${randomUUID().slice(0, 8)}`);
    const categoryId = await insertCategory();
    const completed = await categorizedProject(folderId, categoryId, 'completed');
    const partial = await categorizedProject(folderId, categoryId, 'partially_completed');
    await categorizedProject(folderId, categoryId, 'pending');

    expect(await listIds('evaluated', userId, [GO_PERMISSIONS.PROJECT_READ_ALL])).toEqual(
      [completed, partial].sort(),
    );
  });

  it('lists only bundles, work grants and own projects on "Projects" without it', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const bundled = await insertGrantedFolder(`other-${randomUUID().slice(0, 8)}`);
    const worked = await insertGrantedFolder(userId);
    const elsewhere = await insertGrantedFolder(`other-${randomUUID().slice(0, 8)}`);
    const amThuc = await insertCategory();
    const bienDao = await insertCategory();
    await insertBundle(userId, [bundled], [amThuc]);
    const inBundle = await categorizedProject(bundled, amThuc, 'completed');
    await categorizedProject(bundled, bienDao, 'completed');
    await categorizedProject(elsewhere, amThuc, 'completed');
    const inWorkFolder = await categorizedProject(worked, bienDao, 'completed');
    const own = await insertProject(elsewhere, userId, 'completed');

    expect(await listIds('evaluated', userId)).toEqual([inBundle, inWorkFolder, own].sort());
  });

  it('marks the projects whose originals the user may see', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const bundled = await insertGrantedFolder(`other-${randomUUID().slice(0, 8)}`);
    const worked = await insertGrantedFolder(userId);
    const amThuc = await insertCategory();
    const bienDao = await insertCategory();
    await insertBundle(userId, [bundled], [amThuc]);
    const inBundle = await categorizedProject(bundled, amThuc, 'completed');
    const inWorkFolder = await categorizedProject(worked, bienDao, 'completed');
    const outside = await categorizedProject(bundled, bienDao, 'completed');

    const items = (
      await withPermissions([GO_PERMISSIONS.PROJECT_READ_ALL], () =>
        service.list(listQuery({ scope: 'evaluated' }), userId, 'USER'),
      )
    ).items as unknown as Array<{ id: string; canSeeOriginals: boolean }>;
    const originals = Object.fromEntries(items.map((item) => [item.id, item.canSeeOriginals]));

    expect(originals[inBundle]).toBe(true);
    expect(originals[inWorkFolder]).toBe(true);
    expect(originals[outside]).toBe(false);
  });

  it('limits "Project evaluations" to the categories a folder grant is limited to', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const granted = await insertCategory();
    const other = await insertCategory();
    const folderId = await insertGrantedFolder(userId, { categoryId: granted });
    const pending = await categorizedProject(folderId, granted, 'pending');
    await categorizedProject(folderId, other, 'pending');

    expect(await listIds('evaluation', userId)).toEqual([pending]);
  });

  it('does not open "Project evaluations" to a bundle', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(`other-${randomUUID().slice(0, 8)}`);
    const categoryId = await insertCategory();
    await insertBundle(userId, [folderId], [categoryId]);
    await categorizedProject(folderId, categoryId, 'pending');

    expect(await listIds('evaluation', userId)).toEqual([]);
  });

  it('lists projects to evaluate of granted folders only on "Project evaluations"', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    const hiddenFolderId = await insertGrantedFolder(`other-${randomUUID().slice(0, 8)}`);
    const pending = await insertProject(folderId, 'author-a', 'pending');
    const failed = await insertProject(folderId, 'author-a', 'failed');
    await insertProject(folderId, 'author-a', 'completed');
    await insertProject(hiddenFolderId, 'author-a', 'pending');

    expect(await listIds('evaluation', userId)).toEqual([pending, failed].sort());
  });

  it('lists every project the user created on "My projects", even without folder access', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(`other-${randomUUID().slice(0, 8)}`);
    const draft = await insertProject(folderId, userId, 'draft');
    const completed = await insertProject(folderId, userId, 'completed');
    await insertProject(folderId, 'author-a', 'completed');

    expect(await listIds('mine', userId)).toEqual([draft, completed].sort());
  });

  it('keeps "All projects" for admins', async () => {
    await expect(service.list(listQuery({ scope: 'all' }), 'someone', 'USER')).rejects.toThrow(
      'Only admins can list all projects',
    );
  });
});

describe('ProjectsService — sort by folder', () => {
  it('orders by folder path then project name, both in natural order', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folder9 = await insertGrantedFolder(userId);
    const folder10 = await insertGrantedFolder(userId);
    await ds.query(`UPDATE folders SET path_text = $2 WHERE id = $1`, [folder9, 'Folder 9']);
    await ds.query(`UPDATE folders SET path_text = $2 WHERE id = $1`, [folder10, 'Folder 10']);
    const project = async (folderId: string, name: string) => {
      const id = await insertProject(folderId, 'author-a');
      await ds.query(`UPDATE projects SET name = $2 WHERE id = $1`, [id, name]);
      return id;
    };
    const alpha = await project(folder10, 'Alpha');
    const tenth = await project(folder9, 'Project 10');
    const ninth = await project(folder9, 'Project 9');

    const order = async (sortOrder: 'asc' | 'desc') =>
      (await service.list(listQuery({ sortBy: 'folder', sortOrder }), userId, 'USER')).items.map(
        (p) => (p as unknown as { id: string }).id,
      );

    expect(await order('asc')).toEqual([ninth, tenth, alpha]);
    expect(await order('desc')).toEqual([alpha, tenth, ninth]);
  });
});

describe('ProjectsService — keyword search', () => {
  async function namedProject(folderId: string, name: string, extra: string = '') {
    const id = await insertProject(folderId, 'author-a');
    await ds.query(`UPDATE projects SET name = $2 ${extra} WHERE id = $1`, [id, name]);
    return id;
  }

  async function search(userId: string, keyword: string) {
    return (await service.list(listQuery({ keyword }), userId, 'USER')).items.map(
      (p) => (p as unknown as { id: string }).id,
    );
  }

  it('ignores diacritics, case and spaces in the name', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    const hanoi = await namedProject(folderId, 'Khách sạn Hà Nội');
    await namedProject(folderId, 'Resort Phú Quốc');

    expect(await search(userId, 'ha noi')).toEqual([hanoi]);
    expect(await search(userId, 'HANOI')).toEqual([hanoi]);
    expect(await search(userId, 'khach  san')).toEqual([hanoi]);
  });

  it('finds projects by folder path, category and tag', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    await ds.query(`UPDATE folders SET name = $2, path_text = $3 WHERE id = $1`, [
      folderId,
      'Đà Nẵng',
      'Miền Trung / Đà Nẵng',
    ]);
    const project = await namedProject(folderId, 'Alpha');
    const categoryId = randomUUID();
    const tagId = randomUUID();
    await ds.query(
      `INSERT INTO categories (id, name, slug, sort_order, is_active) VALUES ($1, $2, $3, 0, true)`,
      [categoryId, `Biệt thự ${categoryId.slice(0, 6)}`, `biet-thu-${categoryId}`],
    );
    await ds.query(
      `INSERT INTO tags (id, name, normalized_name, created_by) VALUES ($1,$2,$3,'t')`,
      [tagId, `Hồ bơi ${tagId.slice(0, 6)}`, `hồ bơi ${tagId}`],
    );
    await ds.query(`UPDATE projects SET category_id = $2 WHERE id = $1`, [project, categoryId]);
    await ds.query(`INSERT INTO project_tags (project_id, tag_id) VALUES ($1,$2)`, [
      project,
      tagId,
    ]);

    try {
      expect(await search(userId, 'da nang')).toEqual([project]);
      expect(await search(userId, 'biet thu')).toEqual([project]);
      expect(await search(userId, 'ho boi alpha')).toEqual([project]);
      expect(await search(userId, 'ho boi beta')).toEqual([]);
    } finally {
      await ds.query(`DELETE FROM project_tags WHERE project_id = $1`, [project]);
      await ds.query(`UPDATE projects SET category_id = NULL WHERE id = $1`, [project]);
      await ds.query(`DELETE FROM categories WHERE id = $1`, [categoryId]);
      await ds.query(`DELETE FROM tags WHERE id = $1`, [tagId]);
    }
  });

  it('tolerates a typo in longer words', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    const project = await namedProject(folderId, 'Vinpearl Nha Trang');

    expect(await search(userId, 'vinperl')).toEqual([project]);
    expect(await search(userId, 'nha trangg')).toEqual([project]);
  });

  it('still tries a close spelling when a word only shows up across a space', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    const danang = await namedProject(folderId, 'Bãi biển Đà Nẵng');
    // "nắng gió" reads "nanggio" without its space, which holds "nangg".
    const windy = await namedProject(folderId, 'Đà Lạt nắng gió');

    expect((await search(userId, 'da nangg')).sort()).toEqual([danang, windy].sort());
  });

  it('only tries close spellings for words found nowhere as typed', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    const exact = await namedProject(folderId, 'Trang trại');
    // A close spelling of "trang", which is found as typed above.
    await namedProject(folderId, 'Tráng men');

    expect(await search(userId, 'trang trai')).toEqual([exact]);
  });

  it('follows renamed tags, folders and categories', async () => {
    const userId = `u-${randomUUID().slice(0, 8)}`;
    const folderId = await insertGrantedFolder(userId);
    const project = await namedProject(folderId, 'Omega');
    const categoryId = randomUUID();
    const tagId = randomUUID();
    await ds.query(
      `INSERT INTO categories (id, name, slug, sort_order, is_active) VALUES ($1, 'Cũ', $2, 0, true)`,
      [categoryId, `cu-${categoryId}`],
    );
    await ds.query(
      `INSERT INTO tags (id, name, normalized_name, created_by) VALUES ($1,'cũ',$2,'t')`,
      [tagId, `cũ ${tagId}`],
    );
    await ds.query(`UPDATE projects SET category_id = $2 WHERE id = $1`, [project, categoryId]);
    await ds.query(`INSERT INTO project_tags (project_id, tag_id) VALUES ($1,$2)`, [
      project,
      tagId,
    ]);

    try {
      await ds.query(`UPDATE tags SET name = $2 WHERE id = $1`, [
        tagId,
        `Thác nước ${tagId.slice(0, 6)}`,
      ]);
      await ds.query(`UPDATE categories SET name = $2 WHERE id = $1`, [
        categoryId,
        `Khu nghỉ dưỡng ${categoryId.slice(0, 6)}`,
      ]);
      await ds.query(`UPDATE folders SET path_text = $2 WHERE id = $1`, [
        folderId,
        'Tây Bắc / Mộc Châu',
      ]);

      expect(await search(userId, 'thac nuoc omega')).toEqual([project]);
      expect(await search(userId, 'khu nghi duong omega')).toEqual([project]);
      expect(await search(userId, 'moc chau omega')).toEqual([project]);

      await ds.query(`DELETE FROM project_tags WHERE project_id = $1`, [project]);
      expect(await search(userId, 'thac nuoc omega')).toEqual([]);
    } finally {
      await ds.query(`DELETE FROM project_tags WHERE project_id = $1`, [project]);
      await ds.query(`UPDATE projects SET category_id = NULL WHERE id = $1`, [project]);
      await ds.query(`DELETE FROM categories WHERE id = $1`, [categoryId]);
      await ds.query(`DELETE FROM tags WHERE id = $1`, [tagId]);
    }
  });
});
