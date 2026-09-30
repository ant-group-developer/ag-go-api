/**
 * DB-level tests for the analysis processing log (system_logs, category `analysis`).
 * Run against the test Postgres started by docker-compose.test.yml.
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import { SystemLogService } from '../logs/system-log.service';
import { AnalysisLogService } from './analysis-log.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let service: AnalysisLogService;
/** Tags this run's rows, so the assertions ignore rows other test files left behind. */
const RUN = randomUUID();

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  const repository = ds.getRepository(SystemLogEntity);
  service = new AnalysisLogService(new SystemLogService(repository), repository);

  await service.write({
    level: 'info',
    action: 'analysis.extracted',
    message: `Extracted 100%_clip.mp4 ${RUN}`,
    metadata: { run: RUN },
  });
  await service.write({
    level: 'error',
    action: 'analysis.failed',
    message: `other.mp4: scan.ai failed ${RUN}`,
    metadata: { run: RUN, analysisId: `analysis-${RUN}` },
  });
  // Another category: never part of the analysis log.
  await new SystemLogService(repository).write({
    level: 'info',
    category: 'footage',
    action: 'resolve',
    message: `footage ${RUN}`,
  });
});

afterAll(async () => {
  await ds.query(`DELETE FROM system_logs WHERE message LIKE $1`, [`%${RUN}`]);
  if (ds.isInitialized) await ds.destroy();
});

it('lists only the analysis category, newest first', async () => {
  const page = await service.list({ search: RUN, page: 1, pageSize: 50 });
  expect(page.items.map((item) => item.action)).toEqual(['analysis.failed', 'analysis.extracted']);
  expect(page.total).toBe(2);
});

it('filters by level', async () => {
  const page = await service.list({ search: RUN, level: 'error', page: 1, pageSize: 50 });
  expect(page.items.map((item) => item.action)).toEqual(['analysis.failed']);
});

it('matches ids kept in the metadata', async () => {
  const page = await service.list({ search: `analysis-${RUN}`, page: 1, pageSize: 50 });
  expect(page.items.map((item) => item.action)).toEqual(['analysis.failed']);
});

it('treats % and _ in the search literally', async () => {
  expect((await service.list({ search: '100%_clip', page: 1, pageSize: 50 })).total).toBe(1);
  expect((await service.list({ search: '1_0%', page: 1, pageSize: 50 })).total).toBe(0);
});

it('pages the result', async () => {
  const page = await service.list({ search: RUN, page: 2, pageSize: 1 });
  expect(page.items.map((item) => item.action)).toEqual(['analysis.extracted']);
  expect(page.totalPages).toBe(2);
});
