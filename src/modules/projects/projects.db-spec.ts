/**
 * DB-level tests of the project list's author (owner) filter and the owners lookup.
 * Runs against real Postgres (see footage.db-spec.ts for the setup).
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
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
    ds.getRepository(FolderAccessGrantEntity),
    ds.getRepository(FolderClosureEntity),
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
    await ds.query(`DELETE FROM folder_access_grants WHERE folder_id = ANY($1)`, [
      createdFolderIds,
    ]);
    await ds.query(`DELETE FROM folder_closure WHERE descendant_id = ANY($1)`, [createdFolderIds]);
    await ds.query(`DELETE FROM folders WHERE id = ANY($1)`, [createdFolderIds]);
    createdFolderIds.length = 0;
  }
});

async function insertGrantedFolder(userId: string): Promise<string> {
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
    `INSERT INTO folder_access_grants (id, folder_id, principal_type, principal_id, access_level, inherit_children)
     VALUES ($1,$2,'user',$3,'viewer',true)`,
    [randomUUID(), id, userId],
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

    const owners = await service.owners(userId, 'USER');

    expect(owners.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'author-a', projectCount: 2, user: { id: 'author-a', email: 'author-a@test' } },
      { id: 'author-b', projectCount: 1, user: { id: 'author-b', email: 'author-b@test' } },
    ]);
  });
});
