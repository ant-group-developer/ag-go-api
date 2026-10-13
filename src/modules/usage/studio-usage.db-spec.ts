/**
 * DB-level tests of AG Studio usage: events in (dedupe by event key), usage of an asset and a
 * project out. Runs against the test Postgres (port 55434).
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import type { StudioUsageEventDto } from './dto/studio-events.dto';
import { StudioUsageService } from './studio-usage.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let service: StudioUsageService;

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  service = new StudioUsageService(ds);
});

afterAll(async () => {
  if (ds.isInitialized) await ds.destroy();
});

function event(overrides: Partial<StudioUsageEventDto> = {}): StudioUsageEventDto {
  return {
    eventKey: `src:${randomUUID()}:added`,
    kind: 'source_added',
    occurredAt: '2026-10-10T08:00:00.000Z',
    assetId: randomUUID(),
    agGoProjectId: null,
    studioProjectId: 'prj_1',
    studioProjectName: 'Dự án 1',
    studioVideoId: null,
    studioVideoTitle: null,
    studioUserId: 'auth0|user-1',
    ...overrides,
  };
}

describe('StudioUsageService.record', () => {
  it('stores events once, even when resent or repeated in one request', async () => {
    const jobId = randomUUID();
    const assetId = randomUUID();
    const render = event({
      eventKey: `job:${jobId}:${assetId}`,
      kind: 'final_render',
      assetId,
      studioVideoId: 'vid_1',
      studioVideoTitle: 'Video 1',
    });
    const added = event();

    expect(await service.record([render, added, added])).toEqual({ accepted: 2, duplicates: 1 });
    expect(await service.record([render])).toEqual({ accepted: 0, duplicates: 1 });

    const [row] = await ds.query(
      `SELECT kind, asset_id, studio_job_id, studio_user_id, studio_video_title
       FROM studio_usage_events WHERE event_key = $1`,
      [render.eventKey],
    );
    expect(row).toEqual({
      kind: 'final_render',
      asset_id: assetId,
      studio_job_id: jobId,
      studio_user_id: 'user-1',
      studio_video_title: 'Video 1',
    });
  });
});
