/**
 * DB-level tests of the CTV rate cards (ANTGO-253, spec 7.2.1): the D7 seed (two versions around
 * 15/07/2026), drafts, cloning, publishing that closes the previous version, the version in force
 * on a day and the Excel round trip. Runs against real Postgres (docker-compose.test.yml).
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import type { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import { ListRateCardsQueryDto } from './dto/rate-card.dto';
import { findRateCardInForce, RateCardsService } from './rate-cards.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

const actor: PartnerActor = {
  userId: 'rate-card-admin',
  userType: 'USER',
  permissions: ['go.rate_card.manage'],
};
const code = `TEST-${randomUUID().slice(0, 8)}`;

let ds: DataSource;
let service: RateCardsService;
const systemLog = { write: jest.fn().mockResolvedValue(undefined) };

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  service = new RateCardsService(ds, systemLog as unknown as SystemLogService);
});

afterAll(async () => {
  if (ds?.isInitialized) {
    await ds.query(`DELETE FROM rate_cards WHERE code = $1`, [code]);
    await ds.destroy();
  }
});

async function categoryId(slug: string): Promise<string> {
  const [row] = (await ds.query(`SELECT id FROM categories WHERE slug = $1`, [slug])) as Array<{
    id: string;
  }>;
  return row.id;
}

describe('seed from "Bảng lương CTV (chuẩn)"', () => {
  it('has v1 until 14/07/2026 and v2 with KHÁM PHÁ +200.000 from 15/07', async () => {
    const before = await findRateCardInForce(ds.manager, 'CTV-2026', '2026-07-14');
    const after = await findRateCardInForce(ds.manager, 'CTV-2026', '2026-07-15');
    expect(before).toMatchObject({ version: 1, effectiveTo: '2026-07-14' });
    expect(after).toMatchObject({ version: 2, effectiveTo: null });
    const exploration = await categoryId('kham-pha');
    const scene = await categoryId('canh');
    const price = (card: typeof before, category: string, level: string, tier: number) =>
      card!.content.items.find(
        (item) => item.categoryId === category && item.level === level && item.tier === tier,
      )?.price;
    expect(price(before, exploration, 'LV1', 1)).toBe(800_000);
    expect(price(after, exploration, 'LV1', 1)).toBe(1_000_000);
    expect(price(after, exploration, 'LV3', 3)).toBe(2_200_000);
    expect(price(after, scene, 'LV1', 3)).toBe(1_300_000);
    expect(after!.content.items).toHaveLength(4 * 9 + 2);
    expect(after!.content.levelRules).toEqual([
      { level: 'LV1', extraScenePrice: 80_000, extraSceneMinSources: 8 },
      { level: 'LV2', extraScenePrice: 100_000, extraSceneMinSources: 8 },
      { level: 'LV3', extraScenePrice: 150_000, extraSceneMinSources: 13 },
    ]);
    expect(after!.content.durationRule).toEqual({
      minSeconds: 10,
      preferredSeconds: 20,
      preferredRatio: 0.8,
    });
    expect(await findRateCardInForce(ds.manager, 'CTV-2026', '2025-12-31')).toBeNull();
  });
});

describe('versions', () => {
  it('drafts, clones and publishes, closing the previous version the day before', async () => {
    const scene = await categoryId('canh');
    const drive = await categoryId('lai-xe');
    const first = await service.create(
      {
        code,
        effectiveFrom: '2026-01-01',
        items: [
          {
            categoryId: scene,
            level: 'LV1',
            pricingType: 'tier',
            tier: 1,
            sourceMin: 70,
            sourceMax: 100,
            sceneMin: 6,
            price: 500_000,
          },
          {
            categoryId: drive,
            level: 'ALL',
            pricingType: 'per_source',
            price: 50_000,
            minSourceSeconds: 300,
          },
        ],
        levelRules: [{ level: 'LV1', extraScenePrice: 80_000, extraSceneMinSources: 8 }],
      },
      actor,
    );
    expect(first).toMatchObject({
      version: 1,
      status: 'draft',
      allowedActions: expect.arrayContaining(['publish']),
    });
    expect(first.items.find((item) => item.categoryId === scene)?.categoryName).toBeTruthy();

    await expect(
      service.update(
        first.id,
        { items: [{ categoryId: scene, level: 'ALL', pricingType: 'tier', tier: 1, price: 1 }] },
        actor,
      ),
    ).rejects.toMatchObject({ response: { code: 'RATE_CARD_INVALID' } });

    const updated = await service.update(first.id, { note: 'Bản đầu' }, actor);
    expect(updated.note).toBe('Bản đầu');
    expect(updated.items).toHaveLength(2);

    await service.publish(first.id, undefined, actor);
    await expect(service.update(first.id, { note: 'x' }, actor)).rejects.toMatchObject({
      response: { code: 'RATE_CARD_LOCKED' },
    });

    const second = await service.clone(first.id, { effectiveFrom: '2026-01-01' }, actor);
    expect(second).toMatchObject({ version: 2, status: 'draft' });
    await service.update(
      second.id,
      {
        items: [
          {
            categoryId: scene,
            level: 'LV1',
            pricingType: 'tier',
            tier: 1,
            sourceMin: 70,
            sourceMax: 100,
            sceneMin: 6,
            price: 600_000,
          },
        ],
      },
      actor,
    );
    // Must start after the published version.
    await expect(service.publish(second.id, undefined, actor)).rejects.toMatchObject({
      response: { code: 'RATE_CARD_EFFECTIVE_FROM_INVALID' },
    });
    const published = await service.publish(second.id, '2026-07-15', actor);
    expect(published).toMatchObject({
      status: 'published',
      effectiveFrom: '2026-07-15',
      publishedBy: actor.userId,
    });
    expect((await service.get(first.id)).effectiveTo).toBe('2026-07-14');

    expect((await service.effective(code, '2026-07-14')).version).toBe(1);
    expect((await service.effective(code, '2026-08-01')).items[0].price).toBe(600_000);
    await expect(service.effective(code, '2025-01-01')).rejects.toMatchObject({
      response: { code: 'RATE_CARD_NOT_IN_FORCE' },
    });

    const list = await service.list(Object.assign(new ListRateCardsQueryDto(), { code }));
    expect(list.items.map((item) => [item.version, item.itemCount])).toEqual([
      [2, 1],
      [1, 2],
    ]);

    const archived = await service.archive(first.id, actor);
    expect(archived.status).toBe('archived');
    await expect(service.archive(first.id, actor)).rejects.toMatchObject({
      response: { code: 'RATE_CARD_LOCKED' },
    });

    const draft = await service.clone(second.id, {}, actor);
    await service.remove(draft.id, actor);
    await expect(service.get(draft.id)).rejects.toMatchObject({
      response: { code: 'RATE_CARD_NOT_FOUND' },
    });
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RATE_CARD_PUBLISHED' }),
    );
  });

  it('exports the seeded card to Excel and imports it back as a new draft', async () => {
    const seeded = await service.effective('CTV-2026', '2026-08-01');
    const { fileName, buffer } = await service.exportXlsx(seeded.id);
    expect(fileName).toBe('bang-gia-CTV-2026-v2.xlsx');
    const imported = await service.importXlsx(
      { buffer, originalname: fileName, size: buffer.length },
      { code, effectiveFrom: '2026-12-01', note: 'Nhập lại' },
      actor,
    );
    expect(imported).toMatchObject({
      code,
      status: 'draft',
      sourceFileName: fileName,
      warnings: [],
    });
    const key = (item: { categoryId: string; level: string; tier: number | null; price: number }) =>
      `${item.categoryId}|${item.level}|${item.tier}|${item.price}`;
    expect(imported.items.map(key).sort()).toEqual(seeded.items.map(key).sort());
    expect(imported.levelRules).toEqual(seeded.levelRules);

    await expect(
      service.importXlsx(
        { buffer: Buffer.from('x'), originalname: 'a.csv', size: 1 },
        { code, effectiveFrom: '2026-12-01' },
        actor,
      ),
    ).rejects.toMatchObject({ response: { code: 'RATE_CARD_FILE_INVALID' } });
    await expect(
      service.importXlsx(
        { buffer: Buffer.from('x'), originalname: 'a.xlsx', size: 1 },
        { code, effectiveFrom: '2026-12-01' },
        actor,
      ),
    ).rejects.toMatchObject({ response: { code: 'RATE_CARD_FILE_INVALID' } });
    await expect(
      service.importXlsx(undefined, { code, effectiveFrom: '2026-12-01' }, actor),
    ).rejects.toMatchObject({
      response: { code: 'RATE_CARD_FILE_INVALID' },
    });
  });
});
