/**
 * Filter options of the "Projects" page: every active category and every folder.
 * Run with: yarn test:db
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { CategoryEntity } from '../../database/entities/category.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { FoldersService } from '../folders/folders.service';
import { CategoriesService } from './categories.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
// The ESM build of uuid does not load under ts-jest; these tests create no ids with it.
jest.mock('uuid', () => ({ v7: () => '00000000-0000-7000-9000-000000000000' }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let categories: CategoriesService;
let folders: FoldersService;
const categoryIds: string[] = [];
const folderIds: string[] = [];

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  categories = new CategoriesService(
    ds.getRepository(CategoryEntity),
    ds.getRepository(ProjectEntity),
  );
  folders = new FoldersService(
    ds,
    ds.getRepository(FolderEntity),
    {} as never,
    {} as never,
    {} as never,
  );
});

afterAll(async () => {
  await ds.query(`DELETE FROM categories WHERE id = ANY($1)`, [categoryIds]);
  await ds.query(`DELETE FROM folders WHERE id = ANY($1)`, [folderIds]);
  if (ds?.isInitialized) await ds.destroy();
});

async function insertCategory(name: string): Promise<string> {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO categories (id, name, slug, sort_order, is_active) VALUES ($1, $2, $3, 0, true)`,
    [id, name, `slug-${id}`],
  );
  categoryIds.push(id);
  return id;
}

it('lists every active category', async () => {
  const first = await insertCategory(`First ${randomUUID().slice(0, 8)}`);
  const second = await insertCategory(`Second ${randomUUID().slice(0, 8)}`);

  const ids = (await categories.list()).map((category) => category.id);

  expect(ids).toEqual(expect.arrayContaining([first, second]));
});

it('lists every active folder, parents first, in natural order', async () => {
  const root = randomUUID();
  const child10 = randomUUID();
  const child9 = randomUUID();
  const rows: Array<[string, string | null, string, number]> = [
    [root, null, `Root ${root.slice(0, 6)}`, 0],
    [child10, root, 'Folder 10', 1],
    [child9, root, 'Folder 9', 1],
  ];
  for (const [id, parentId, name, depth] of rows) {
    await ds.query(
      `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, sort_order, is_active, created_by)
       VALUES ($1, $2, $3, $4, '{}', $5, $6, 0, true, 'test')`,
      [id, parentId, name, `/${id}`, name, depth],
    );
    folderIds.push(id);
  }

  const options = (await folders.options()).filter((folder) => folderIds.includes(folder.id));

  expect(options.map((folder) => folder.name)).toEqual([rows[0][2], 'Folder 9', 'Folder 10']);
  expect(options[1]).toEqual({
    id: child9,
    parentId: root,
    name: 'Folder 9',
    pathText: 'Folder 9',
    pathIds: [],
    depth: 1,
  });
});
