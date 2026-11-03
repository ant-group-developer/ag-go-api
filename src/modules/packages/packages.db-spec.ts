/**
 * DB-level tests of product packages (ANTGO-253, spec 7.4.1, FR-K-01…08): creation by the CTV and
 * by the manager, project rules, the provisional computation (D6 / TC-5, TC-10), submit / withdraw
 * / return / reopen and the automatic move to `evaluated` when the evaluation of the projects ends.
 * Runs against real Postgres (docker-compose.test.yml) with the seeded rate card CTV-2026.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { ContractFixtures } from '../acceptances/testing/db-fixtures';
import type { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import { ListPackagesQueryDto } from './dto/package.dto';
import { PackagesService } from './packages.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let fixtures: ContractFixtures;
let service: PackagesService;
const systemLog = { write: jest.fn().mockResolvedValue(undefined) };

const manager: PartnerActor = {
  userId: 'pkg-manager',
  userType: 'USER',
  permissions: ['go.acceptance.prepare', 'go.contract.read'],
};
const evaluator: PartnerActor = {
  userId: 'pkg-evaluator',
  userType: 'USER',
  permissions: ['go.project.evaluate'],
};
const stranger: PartnerActor = {
  userId: 'pkg-stranger',
  userType: 'USER',
  permissions: ['go.project.edit'],
};

let scene: string;
let exploration: string;
let drive: string;

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  fixtures = new ContractFixtures(ds);
  await fixtures.setup();
  service = new PackagesService(ds, systemLog as unknown as SystemLogService);
  scene = await fixtures.categoryId('canh');
  exploration = await fixtures.categoryId('kham-pha');
  drive = await fixtures.categoryId('lai-xe');
});

afterAll(async () => {
  if (ds?.isInitialized) {
    await fixtures.cleanup();
    await ds.destroy();
  }
});

async function ctvWithContract(level = 'LV1', categories = [scene, exploration, drive]) {
  const partner = await fixtures.partner(manager.userId);
  const contractId = await fixtures.contract(partner.id, manager.userId, {
    pricingConfig: {
      rate_card_id: 'CTV-2026',
      level,
      category_ids: categories,
      employment_stage: 'official',
    },
  });
  const ctv: PartnerActor = {
    userId: partner.goUserId,
    userType: 'USER',
    permissions: ['go.project.read', 'go.project.edit'],
  };
  return { partner, contractId, ctv };
}

/** `count` projects of the category with `sources[i]` videos of 25 s each, pending. */
async function scenes(ownerUserId: string, categoryId: string, sources: number[]) {
  const ids: string[] = [];
  for (const count of sources) {
    const id = await fixtures.project(ownerUserId, { categoryId });
    await fixtures.videos(id, Array(count).fill(25));
    ids.push(id);
  }
  return ids;
}

function split(total: number, parts: number) {
  return Array.from(
    { length: parts },
    (_, index) => Math.floor(total / parts) + (index < total % parts ? 1 : 0),
  );
}

describe('creation (FR-K-01)', () => {
  it('lets the CTV create a package without naming the contract, with a generated code', async () => {
    const { partner, contractId, ctv } = await ctvWithContract();
    const pkg = await service.create({ categoryId: scene, name: 'Cảnh Đà Lạt' }, ctv);
    expect(pkg).toMatchObject({
      contractId,
      partnerId: partner.id,
      status: 'open',
      code: `CA-${partner.code}-0001`,
      name: 'Cảnh Đà Lạt',
      allowedActions: expect.arrayContaining(['submit', 'add_project', 'cancel']),
    });
    const second = await service.create({ categoryId: exploration, contractId }, manager);
    expect(second.code).toBe(`KP-${partner.code}-0002`);
  });

  it('refuses another category, per-source products and strangers', async () => {
    const { contractId, ctv } = await ctvWithContract('LV1', [scene, drive]);
    await expect(
      service.create({ categoryId: exploration, contractId }, ctv),
    ).rejects.toMatchObject({
      response: { code: 'PACKAGE_CATEGORY_INVALID' },
    });
    await expect(service.create({ categoryId: drive, contractId }, ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_CATEGORY_INVALID' },
    });
    await expect(service.create({ categoryId: scene, contractId }, stranger)).rejects.toMatchObject(
      {
        response: { code: 'PACKAGE_FORBIDDEN' },
      },
    );
    await expect(service.create({ categoryId: exploration }, ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_CONTRACT_REQUIRED' },
    });
  });
});

describe('projects and the provisional computation (FR-K-02, FR-K-03)', () => {
  it('TC-5 / D6: 14 scenes, 158 sources of CẢNH at LV1 → Mức 3 = 1.300.000', async () => {
    const { partner, ctv } = await ctvWithContract();
    const pkg = await service.create({ categoryId: scene }, ctv);
    const ids = await scenes(partner.goUserId, scene, split(158, 14));
    for (const id of ids) {
      await service.addProject(pkg.id, id, ctv);
    }
    const detail = await service.get(pkg.id, ctv);
    expect(detail.projectCount).toBe(14);
    expect(detail.pricing).toMatchObject({
      mode: 'provisional',
      level: 'LV1',
      rateCard: { code: 'CTV-2026' },
      result: { scenes: 14, sources: 158, tier: 3, amount: 1_300_000, extraScenes: 0 },
    });
    expect(detail.preview).toMatchObject({ tier: 3, amount: 1_300_000 });
    // The project got the package's contract when it was linked on delivery.
    const [linked] = (await ds.query(`SELECT contract_id FROM projects WHERE id = $1`, [
      ids[0],
    ])) as Array<{
      contract_id: string;
    }>;
    expect(linked.contract_id).toBe(detail.contractId);
  });

  it('refuses projects of another partner, another category, or already in a package', async () => {
    const { partner, ctv } = await ctvWithContract();
    const other = await ctvWithContract();
    const pkg = await service.create({ categoryId: scene }, ctv);
    const otherPkg = await service.create({ categoryId: scene }, ctv);
    const [foreign] = await scenes(other.partner.goUserId, scene, [10]);
    const [wrongCategory] = await scenes(partner.goUserId, exploration, [10]);
    const [mine] = await scenes(partner.goUserId, scene, [10]);
    await expect(service.addProject(pkg.id, foreign, ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_PROJECT_INVALID' },
    });
    await expect(service.addProject(pkg.id, wrongCategory, ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_PROJECT_INVALID' },
    });
    await service.addProject(pkg.id, mine, ctv);
    await expect(service.addProject(otherPkg.id, mine, ctv)).rejects.toMatchObject({
      response: { code: 'PROJECT_IN_OTHER_PACKAGE' },
    });
    await expect(service.addProject(pkg.id, mine, other.ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_NOT_FOUND' },
    });
    const removed = await service.removeProject(pkg.id, mine, ctv);
    expect(removed.projectCount).toBe(0);
    await expect(service.removeProject(pkg.id, mine, ctv)).rejects.toMatchObject({
      response: { code: 'PROJECT_NOT_FOUND' },
    });
  });
});

describe('state machine (FR-K-04 … FR-K-08)', () => {
  it('TC-10: refuses to submit below Mức 1 with what is missing', async () => {
    const { partner, ctv } = await ctvWithContract();
    const pkg = await service.create({ categoryId: exploration }, ctv);
    await expect(service.submit(pkg.id, ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_EMPTY' },
    });
    for (const id of await scenes(partner.goUserId, exploration, split(60, 7))) {
      await service.addProject(pkg.id, id, ctv);
    }
    await expect(service.submit(pkg.id, ctv)).rejects.toMatchObject({
      response: {
        code: 'PACKAGE_BELOW_TIER_1',
        message: 'Gói chưa đạt Mức 1: thiếu 10 source',
        details: { next: { tier: 1, missingSources: 10, missingScenes: 0 } },
      },
    });
  });

  it('submits, locks, withdraws, becomes evaluated with its projects, returns and reopens', async () => {
    const { partner, ctv } = await ctvWithContract();
    const pkg = await service.create({ categoryId: scene }, ctv);
    const ids = await scenes(partner.goUserId, scene, split(80, 6));
    for (const id of ids) {
      await service.addProject(pkg.id, id, ctv);
    }
    const submitted = await service.submit(pkg.id, ctv);
    expect(submitted).toMatchObject({
      status: 'submitted',
      submittedBy: ctv.userId,
      submittedPreview: { tier: 1, amount: 500_000 },
      allowedActions: ['withdraw'],
    });
    const [extra] = await scenes(partner.goUserId, scene, [8]);
    await expect(service.addProject(pkg.id, extra, ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_LOCKED' },
    });
    expect((await service.withdraw(pkg.id, ctv)).status).toBe('open');
    await service.submit(pkg.id, manager);

    // Evaluation of every project but the last keeps it submitted.
    for (const id of ids.slice(0, -1)) {
      await fixtures.evaluate(id, 'approved');
    }
    expect((await service.get(pkg.id, ctv)).status).toBe('submitted');
    await fixtures.evaluate(ids.at(-1)!, 'approved');
    const evaluated = await service.get(pkg.id, ctv);
    expect(evaluated).toMatchObject({
      status: 'evaluated',
      pricing: { mode: 'final', result: { tier: 1 } },
    });
    expect(evaluated.evaluatedAt).toBeInstanceOf(Date);

    const ready = await service.list(
      Object.assign(new ListPackagesQueryDto(), {
        readyForAcceptance: true,
        partnerId: partner.id,
      }),
      manager,
    );
    expect(ready.items.map((item) => item.id)).toEqual([pkg.id]);

    // A project back to pending moves it back to submitted.
    await fixtures.evaluate(ids[0], 'pending');
    expect((await service.get(pkg.id, ctv)).status).toBe('submitted');
    await fixtures.evaluate(ids[0], 'approved');

    await expect(service.returnPackage(pkg.id, 'Thiếu cảnh', ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_FORBIDDEN' },
    });
    const returned = await service.returnPackage(pkg.id, ' Thiếu cảnh toàn ', evaluator);
    expect(returned).toMatchObject({
      status: 'open',
      returnedReason: 'Thiếu cảnh toàn',
      returnedBy: evaluator.userId,
    });

    await service.submit(pkg.id, ctv);
    expect((await service.get(pkg.id, ctv)).status).toBe('evaluated');
    const reopened = await service.reopen(pkg.id, ctv);
    expect(reopened.status).toBe('open');
    await expect(service.reopen(pkg.id, ctv)).rejects.toMatchObject({
      response: { code: 'PACKAGE_INVALID_TRANSITION' },
    });

    const cancelled = await service.cancel(pkg.id, ctv);
    expect(cancelled).toMatchObject({ status: 'cancelled', projectCount: 0 });
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PACKAGE_SUBMIT' }),
    );
  });

  it('lists the CTV own packages only, and what managers and evaluators see', async () => {
    const first = await ctvWithContract();
    const second = await ctvWithContract();
    const mine = await service.create({ categoryId: scene }, first.ctv);
    await service.create({ categoryId: scene }, second.ctv);
    const own = await service.list(new ListPackagesQueryDto(), first.ctv);
    expect(own.items.map((item) => item.id)).toEqual([mine.id]);
    const managed = await service.list(
      Object.assign(new ListPackagesQueryDto(), { partnerId: first.partner.id }),
      manager,
    );
    expect(managed.total).toBe(1);
    const others = await service.list(
      Object.assign(new ListPackagesQueryDto(), { partnerId: first.partner.id }),
      { ...manager, userId: 'someone-else' },
    );
    expect(others.total).toBe(0);
    const evaluated = await service.list(
      Object.assign(new ListPackagesQueryDto(), {
        partnerId: first.partner.id,
        keyword: mine.code,
      }),
      evaluator,
    );
    expect(evaluated.items[0].allowedActions).toEqual([]);
  });
});
