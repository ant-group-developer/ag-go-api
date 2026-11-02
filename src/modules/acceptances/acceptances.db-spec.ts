/**
 * DB-level tests of acceptance records (ANTGO-253, spec 5.3, 6.4, 6.8, 9.3–9.5) on the three
 * pricing models, checked against the real records: D2 (29 topics = 72.500.000), D4 (61 shots =
 * 18.300.000, net 16.470.000) and D6 (CẢNH LV1, 158 sources, 14 scenes = 1.300.000). Also gathering
 * rules (BR-20, never twice), adjustments with reasons, the ceiling, approval notes on warnings,
 * issue numbering and cancel. AG Account is mocked; runs against real Postgres.
 */
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { AppDataSource } from '../../database/data-source';
import { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import { ContractEntity } from '../../database/entities/contract.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { ContractsService } from '../contracts/contracts.service';
import { documentsStub, STUB_COMPANY, STUB_TEMPLATE_ID } from '../documents/testing/documents-stub';
import type { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import type { PartnersService } from '../partners/partners.service';
import { AcceptancesService } from './acceptances.service';
import { ListAcceptancesQueryDto } from './dto/acceptance.dto';
import { ContractFixtures } from './testing/db-fixtures';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let fixtures: ContractFixtures;
let service: AcceptancesService;
const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
const partners = {
  readProfileForDocument: jest.fn().mockResolvedValue({
    profile: { version: '7', name: 'Nguyễn Hữu Hoàng', citizen_id_number: '035086000030' },
    completeness: { complete: true, missing: [] },
  }),
};
const cipher = { encryptJson: jest.fn().mockReturnValue('k1:encrypted') };
const documents = documentsStub();

const preparer: PartnerActor = {
  userId: 'bbnt-manager',
  userType: 'USER',
  permissions: ['go.contract.read', 'go.acceptance.prepare'],
};
const approver: PartnerActor = {
  userId: 'bbnt-approver',
  userType: 'USER',
  permissions: ['go.contract.read', 'go.contract.read_all', 'go.acceptance.approve'],
};

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  fixtures = new ContractFixtures(ds);
  await fixtures.setup();
  const contracts = new ContractsService(
    ds,
    ds.getRepository(ContractEntity),
    ds.getRepository(ContractAmendmentEntity),
    ds.getRepository(PartnerEntity),
    partners as unknown as PartnersService,
    {} as never,
    systemLog as unknown as SystemLogService,
    documents,
  );
  service = new AcceptancesService(
    ds,
    contracts,
    partners as unknown as PartnersService,
    cipher as unknown as PiiCipherService,
    systemLog as unknown as SystemLogService,
    documents,
  );
});

afterAll(async () => {
  if (ds?.isInitialized) {
    await fixtures.cleanup();
    await ds.destroy();
  }
});

/** A project of the contract delivered on `deliveredAt` with approved videos of these durations. */
async function deliveredProject(
  ownerUserId: string,
  contractId: string,
  durations: Array<number | null>,
  options: { categoryId?: string | null; deliveredAt?: string; name?: string } = {},
) {
  const id = await fixtures.project(ownerUserId, {
    contractId,
    categoryId: options.categoryId ?? null,
    deliveredAt: options.deliveredAt ?? '2026-09-20T03:00:00Z',
    name: options.name,
  });
  await fixtures.videos(id, durations, 'approved');
  return id;
}

/** An evaluated package of the contract with projects of these durations (all approved). */
async function evaluatedPackage(
  partner: { id: string; goUserId: string },
  contractId: string,
  categoryId: string,
  projects: number[][],
  options: { evaluatedAt?: string; submittedTier?: number } = {},
) {
  const id = randomUUID();
  const code = `PK-${id.slice(0, 8)}`;
  await ds.query(
    `INSERT INTO product_packages (id, contract_id, partner_id, category_id, sequence_number, code,
       status, submitted_at, evaluated_at, submitted_preview, created_by)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM product_packages
       WHERE partner_id = $3), $5, 'evaluated', $6, $6, $7, 'test')`,
    [
      id,
      contractId,
      partner.id,
      categoryId,
      code,
      options.evaluatedAt ?? '2026-07-10T03:00:00Z',
      JSON.stringify({ tier: options.submittedTier ?? null }),
    ],
  );
  for (const durations of projects) {
    const projectId = await fixtures.project(partner.goUserId, {
      contractId,
      categoryId,
      deliveredAt: '2026-07-01T03:00:00Z',
    });
    await ds.query(`UPDATE projects SET package_id = $2 WHERE id = $1`, [projectId, id]);
    await fixtures.videos(projectId, durations, 'approved');
  }
  return { id, code };
}

function split(total: number, parts: number) {
  return Array.from(
    { length: parts },
    (_, index) => Math.floor(total / parts) + (index < total % parts ? 1 : 0),
  );
}

async function packageTierContract(level: string, extra: Record<string, unknown> = {}) {
  const partner = await fixtures.partner(preparer.userId);
  const categories = await Promise.all(
    ['camping', 'kham-pha', 'doi-song', 'canh', 'lai-xe', 'flycam'].map((slug) =>
      fixtures.categoryId(slug),
    ),
  );
  const contractId = await fixtures.contract(partner.id, preparer.userId, {
    pricingConfig: {
      rate_card_id: 'CTV-2026',
      level,
      category_ids: categories,
      employment_stage: 'official',
    },
    ...extra,
  });
  return { partner, contractId };
}

// ---------------------------------------------------------------------------

describe('per_topic — real record D2 (Nguyễn Hữu Hoàng, phụ lục số 2)', () => {
  it('29 topics × 2.500.000 = 72.500.000, net 65.250.000; the 18-minute project is left out (TC-1, TC-2)', async () => {
    const partner = await fixtures.partner(preparer.userId);
    const contractId = await fixtures.contract(partner.id, preparer.userId, {
      pricingModel: 'per_topic',
      pricingConfig: { unit_price: 2_500_000, min_topic_minutes: 20, max_topic_minutes: 60 },
      lastAppendixNumber: 1,
    });
    for (let index = 0; index < 29; index += 1) {
      await deliveredProject(partner.goUserId, contractId, [650, 600]); // 20,8 phút
    }
    const short = await deliveredProject(partner.goUserId, contractId, [540, 540]); // 18 phút
    // Delivered after the period: next record.
    await deliveredProject(partner.goUserId, contractId, [1300], {
      deliveredAt: '2026-10-05T03:00:00Z',
    });

    const record = await service.create(
      contractId,
      { periodStart: '2026-09-01', periodEnd: '2026-09-30', recordDate: '2026-10-07' },
      preparer,
    );
    expect(record).toMatchObject({
      status: 'draft',
      pricingModel: 'per_topic',
      grossAmount: 72_500_000,
      taxRate: 10,
      taxAmount: 7_250_000,
      advanceOffsetAmount: 0,
      netPayable: 65_250_000,
      netPayableWords: 'Sáu mươi lăm triệu hai trăm năm mươi nghìn đồng',
      appendixNumber: null,
    });
    expect(record.items).toHaveLength(1);
    expect(record.items[0]).toMatchObject({
      unit: 'topic',
      computedQuantity: 29,
      quantity: 29,
      unitPrice: 2_500_000,
      amount: 72_500_000,
      productLabel: 'Video chủ đề',
    });
    const excluded = record.sources.find((source) => source.projectId === short);
    expect(excluded).toMatchObject({
      counted: false,
      isActive: false,
      exclusionReason: 'below_min_minutes',
      exclusionMessage: 'Thiếu 2 phút so với tối thiểu 20 phút',
    });
    expect(record.sources.filter((source) => source.counted)).toHaveLength(29);

    // Labelled as on the paper record.
    const relabelled = await service.adjustItem(
      record.id,
      record.items[0].id,
      { productLabel: 'VIDEO TRẢI NGHIỆM' },
      preparer,
    );
    expect(relabelled.items[0].productLabel).toBe('VIDEO TRẢI NGHIỆM');

    await service.submit(record.id, preparer);
    await expect(service.approve(record.id, undefined, preparer)).rejects.toMatchObject({
      response: { code: 'ACCEPTANCE_FORBIDDEN' },
    });
    await service.approve(record.id, undefined, approver);
    const issued = await service.issue(record.id, approver);
    expect(issued).toMatchObject({
      status: 'issued',
      appendixNumber: 2,
      recordDate: '2026-10-07',
      hasPartnerSnapshot: true,
      companySnapshot: STUB_COMPANY,
      templateVersionId: STUB_TEMPLATE_ID,
    });
    // Checked before the number is taken, rendered by worker-io after (documents.db-spec).
    expect(documents.calls.prepareIssue.at(-1)?.slice(0, 2)).toEqual(['acceptance', record.id]);
    expect(documents.calls.requestGeneration.at(-1)).toMatchObject({
      ownerType: 'acceptance',
      ownerId: record.id,
      templateId: STUB_TEMPLATE_ID,
    });
    expect(issued).not.toHaveProperty('partnerSnapshotEnc');
    const [contract] = (await ds.query(
      `SELECT last_appendix_number AS last FROM contracts WHERE id = $1`,
      [contractId],
    )) as Array<{ last: number }>;
    expect(contract.last).toBe(2);
    await expect(service.update(record.id, { deliveryNote: 'x' }, preparer)).rejects.toMatchObject({
      response: { code: 'ACCEPTANCE_LOCKED' },
    });

    // The projects are counted: the next record of the period finds nothing new.
    const next = await service.create(
      contractId,
      { periodStart: '2026-09-01', periodEnd: '2026-10-31' },
      preparer,
    );
    expect(next.grossAmount).toBe(2_500_000); // only the project delivered in October
    await service.cancel(next.id, 'Lập lại', preparer);

    const signed = await service.sign(record.id, { signedDate: '2026-10-09' }, approver);
    expect(signed).toMatchObject({ status: 'signed', dueDate: '2026-10-23' });
  });
});

describe('per_unit — real record D4 (Nguyễn Văn Cường, THIÊN NHIÊN)', () => {
  it('61 shots × 300.000 = 18.300.000; tax 1.830.000; net 16.470.000 in words (TC-3)', async () => {
    const partner = await fixtures.partner(preparer.userId);
    const contractId = await fixtures.contract(partner.id, preparer.userId, {
      pricingModel: 'per_unit',
      pricingConfig: { unit: 'shot', unit_price: 300_000, min_shot_seconds: 60 },
      lastAppendixNumber: 3,
    });
    const nature = await fixtures.categoryId('canh');
    const shots = Array.from({ length: 61 }, (_, index) => 60 + index);
    await deliveredProject(partner.goUserId, contractId, [...shots, 45, null], {
      categoryId: nature,
    });
    const record = await service.create(
      contractId,
      { periodStart: '2026-08-01', periodEnd: '2026-09-30' },
      preparer,
    );
    expect(record).toMatchObject({
      grossAmount: 18_300_000,
      taxAmount: 1_830_000,
      netPayable: 16_470_000,
      netPayableWords: 'Mười sáu triệu bốn trăm bảy mươi nghìn đồng',
    });
    expect(record.items[0]).toMatchObject({ unit: 'shot', quantity: 61, unitPrice: 300_000 });
    expect(record.sources[0].metrics).toEqual({
      excluded: { below_min_duration: 1, unknown_duration: 1 },
    });
  });

  it('TC-4: with 50.000.000 advance (full_first) offsets 16.470.000 and pays 0', async () => {
    const partner = await fixtures.partner(preparer.userId);
    const contractId = await fixtures.contract(partner.id, preparer.userId, {
      pricingModel: 'per_unit',
      pricingConfig: { unit: 'shot', unit_price: 300_000, min_shot_seconds: 60 },
      capAmount: 100_000_000,
      advanceAmount: 50_000_000,
    });
    await deliveredProject(partner.goUserId, contractId, Array(61).fill(75));
    const record = await service.create(
      contractId,
      { periodStart: '2026-08-01', periodEnd: '2026-09-30' },
      preparer,
    );
    expect(record).toMatchObject({
      grossAmount: 18_300_000,
      taxAmount: 1_830_000,
      advanceOffsetAmount: 16_470_000,
      netPayable: 0,
      netPayableWords: 'Không đồng',
    });

    // Typed tax and offset need reasons; dropping them goes back to the computed values.
    await expect(service.update(record.id, { taxAmount: 0 }, preparer)).rejects.toMatchObject({
      response: { code: 'ACCEPTANCE_ADJUSTMENT_REASON_REQUIRED' },
    });
    const typed = await service.update(
      record.id,
      {
        taxAmount: 0,
        taxOverrideReason: 'Đối tác tự quyết toán',
        advanceOffsetAmount: 10_000_000,
        advanceOffsetReason: 'Đối trừ một phần',
      },
      preparer,
    );
    expect(typed).toMatchObject({
      taxAmount: 0,
      taxOverridden: true,
      advanceOffsetAmount: 10_000_000,
      netPayable: 8_300_000,
    });
    const reset = await service.update(
      record.id,
      { taxAmount: null, advanceOffsetAmount: null },
      preparer,
    );
    expect(reset).toMatchObject({ taxAmount: 1_830_000, taxOverridden: false, netPayable: 0 });
  });
});

describe('package_tier — real record D6 (Nguyễn Thị Xuân N., phụ lục số 4)', () => {
  it('CẢNH LV1, 14 scenes, 158 sources → Mức 3 = 1.300.000; tax 130.000; net 1.170.000 (TC-5)', async () => {
    const { partner, contractId } = await packageTierContract('LV1', { lastAppendixNumber: 3 });
    const scene = await fixtures.categoryId('canh');
    const pkg = await evaluatedPackage(
      partner,
      contractId,
      scene,
      split(158, 14).map((count) => Array(count).fill(25)),
      { submittedTier: 3 },
    );
    const record = await service.create(
      contractId,
      { periodStart: '2026-07-20', periodEnd: '2026-07-26' },
      preparer,
    );
    expect(record).toMatchObject({
      grossAmount: 1_300_000,
      taxAmount: 130_000,
      netPayable: 1_170_000,
      netPayableWords: 'Một triệu một trăm bảy mươi nghìn đồng',
      termsSnapshot: { rate_card: { code: 'CTV-2026', version: 2 } },
      warnings: [],
    });
    expect(record.items).toHaveLength(1);
    expect(record.items[0]).toMatchObject({
      unit: 'package',
      packageId: pkg.id,
      level: 'LV1',
      quantity: 1,
      unitPrice: 1_300_000,
      metrics: { sources: 158, scenes: 14, tier: 3, packageCode: pkg.code },
    });
    expect(record.items[0].rateCardItemId).toBeTruthy();
    const [held] = (await ds.query(
      `SELECT acceptance_id AS "acceptanceId", status FROM product_packages WHERE id = $1`,
      [pkg.id],
    )) as Array<{ acceptanceId: string; status: string }>;
    expect(held).toEqual({ acceptanceId: record.id, status: 'evaluated' });

    await service.submit(record.id, preparer);
    await service.approve(record.id, undefined, approver);
    const issued = await service.issue(record.id, approver);
    expect(issued.appendixNumber).toBe(4);
    const [accepted] = (await ds.query(`SELECT status FROM product_packages WHERE id = $1`, [
      pkg.id,
    ])) as Array<{ status: string }>;
    expect(accepted.status).toBe('accepted');

    // Cancelling an issued record releases the package; its number is not reused.
    await expect(service.cancel(record.id, 'Sai kỳ', preparer)).rejects.toMatchObject({
      response: { code: 'ACCEPTANCE_FORBIDDEN' },
    });
    const cancelled = await service.cancel(record.id, 'Sai kỳ', approver);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledReason: 'Sai kỳ' });
    const [released] = (await ds.query(
      `SELECT status, acceptance_id AS "acceptanceId" FROM product_packages WHERE id = $1`,
      [pkg.id],
    )) as Array<{ status: string; acceptanceId: string | null }>;
    expect(released).toEqual({ status: 'evaluated', acceptanceId: null });
    const again = await service.create(
      contractId,
      { periodStart: '2026-07-20', periodEnd: '2026-07-26' },
      preparer,
    );
    await service.submit(again.id, preparer);
    await service.approve(again.id, undefined, approver);
    expect((await service.issue(again.id, approver)).appendixNumber).toBe(5);
  });

  it('prices on the version in force at the period end, extra scenes and Lái xe (TC-7, TC-8, TC-12)', async () => {
    const { partner, contractId } = await packageTierContract('LV2');
    const camping = await fixtures.categoryId('camping');
    const drive = await fixtures.categoryId('lai-xe');
    await evaluatedPackage(
      partner,
      contractId,
      camping,
      split(230, 16).map((n) => Array(n).fill(30)),
    );
    await deliveredProject(partner.goUserId, contractId, [...Array(11).fill(310), 240], {
      categoryId: drive,
      deliveredAt: '2026-07-05T03:00:00Z',
    });
    const preview = await service.eligible(contractId, '2026-07-20', preparer);
    expect(
      preview.lines.map((line) => [line.unit, line.quantity, line.unitPrice, line.amount]),
    ).toEqual([
      ['package', 1, 1_800_000, 1_800_000],
      ['extra_scene', 3, 100_000, 300_000],
      ['source', 11, 50_000, 550_000],
    ]);
    expect(preview.uncounted).toEqual([]);

    // TC-7 on a LV1 contract: KHÁM PHÁ 120 sources / 8 scenes → 800.000 before 15/07, 1.000.000 after.
    const lv1 = await packageTierContract('LV1');
    const exploration = await fixtures.categoryId('kham-pha');
    await evaluatedPackage(
      lv1.partner,
      lv1.contractId,
      exploration,
      Array(8).fill(Array(15).fill(25)),
    );
    expect((await service.eligible(lv1.contractId, '2026-07-14', preparer)).lines[0].amount).toBe(
      800_000,
    );
    expect((await service.eligible(lv1.contractId, '2026-07-20', preparer)).lines[0].amount).toBe(
      1_000_000,
    );
  });

  it('warns on 80/20 and tier drops, and needs the approver note (TC-11, FR-K-08)', async () => {
    const { partner, contractId } = await packageTierContract('LV1');
    const scene = await fixtures.categoryId('canh');
    const durations = [...Array(5).fill(8), ...Array(40).fill(15), ...Array(113).fill(30)];
    await evaluatedPackage(
      partner,
      contractId,
      scene,
      Array.from({ length: 14 }, (_, index) =>
        durations.filter((_, position) => position % 14 === index),
      ),
      { submittedTier: 3 },
    );
    const thin = await evaluatedPackage(
      partner,
      contractId,
      scene,
      Array(7).fill(Array(10).fill(25)),
      {
        submittedTier: 1,
        evaluatedAt: '2026-07-11T03:00:00Z',
      },
    );
    const record = await service.create(
      contractId,
      { periodStart: '2026-07-01', periodEnd: '2026-07-31' },
      preparer,
    );
    expect(record.items.map((item) => item.amount)).toEqual([1_300_000, 500_000]);
    expect(record.warnings.map((warning) => warning.code)).toEqual(['DURATION_RATIO']);
    expect(record.warnings[0].message).toContain('113/153 source ≥ 20s (73,9% < 80%)');

    // One project of the thin package is rejected later: the package falls below Mức 1.
    const [project] = (await ds.query(`SELECT id FROM projects WHERE package_id = $1 LIMIT 1`, [
      thin.id,
    ])) as Array<{ id: string }>;
    await ds.query(
      `UPDATE project_media SET evaluation_status = 'rejected' WHERE project_id = $1`,
      [project.id],
    );
    const recalculated = await service.recalculate(record.id, preparer);
    expect(recalculated.items[1]).toMatchObject({ unitPrice: 0, amount: 0 });
    expect(recalculated.warnings.map((warning) => warning.code).sort()).toEqual([
      'BELOW_TIER_1',
      'DURATION_RATIO',
      'TIER_DROPPED',
    ]);

    // Not paid (Q-R4) unless adjusted with a reason; issue refuses unpriced lines.
    await expect(
      service.adjustItem(record.id, recalculated.items[1].id, { unitPrice: 300_000 }, preparer),
    ).rejects.toMatchObject({ response: { code: 'ACCEPTANCE_ADJUSTMENT_REASON_REQUIRED' } });
    const adjusted = await service.adjustItem(
      record.id,
      recalculated.items[1].id,
      { unitPrice: 300_000, reason: 'Trả một phần theo thoả thuận' },
      preparer,
    );
    expect(adjusted.grossAmount).toBe(1_600_000);
    // The adjustment survives a recalculation.
    const kept = await service.recalculate(record.id, preparer);
    expect(kept.items[1]).toMatchObject({
      computedUnitPrice: 0,
      unitPrice: 300_000,
      adjustmentReason: 'Trả một phần theo thoả thuận',
    });

    await service.submit(record.id, preparer);
    await expect(service.approve(record.id, undefined, approver)).rejects.toMatchObject({
      response: { code: 'ACCEPTANCE_APPROVAL_NOTE_REQUIRED' },
    });
    await service.returnRecord(record.id, 'Xem lại gói mỏng', approver);
    await service.submit(record.id, preparer);
    const approved = await service.approve(record.id, 'Chấp nhận dù không đạt 80/20', approver);
    expect(approved).toMatchObject({
      status: 'approved',
      approvalNote: 'Chấp nhận dù không đạt 80/20',
    });
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ACCEPTANCE_ITEM_ADJUSTED' }),
    );
  });
});

describe('NFR-01', () => {
  it('prices a contract with 5.000 videos in under 3 seconds (SQL aggregation)', async () => {
    const partner = await fixtures.partner(preparer.userId);
    const contractId = await fixtures.contract(partner.id, preparer.userId, {
      pricingModel: 'per_unit',
      pricingConfig: { unit: 'shot', unit_price: 300_000, min_shot_seconds: 60 },
    });
    for (let index = 0; index < 50; index += 1) {
      await deliveredProject(
        partner.goUserId,
        contractId,
        Array.from({ length: 100 }, (_, position) => 30 + position),
      );
    }
    const started = Date.now();
    const record = await service.create(
      contractId,
      { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
      preparer,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(record.items[0].quantity).toBe(50 * 70);
  });
});

describe('ceiling and visibility', () => {
  it('warns over the ceiling and blocks approval (BR-15, FR-C-09)', async () => {
    const partner = await fixtures.partner(preparer.userId);
    const contractId = await fixtures.contract(partner.id, preparer.userId, {
      pricingModel: 'per_topic',
      pricingConfig: { unit_price: 2_500_000, min_topic_minutes: 20 },
      capAmount: 6_000_000,
    });
    for (let index = 0; index < 3; index += 1) {
      await deliveredProject(partner.goUserId, contractId, [1300]);
    }
    const record = await service.create(
      contractId,
      { periodStart: '2026-09-01', periodEnd: '2026-09-30' },
      preparer,
    );
    expect(record.cap).toMatchObject({ capAmount: 6_000_000, total: 7_500_000, exceeded: true });
    expect(record.warnings.map((warning) => warning.code)).toEqual(['CAP_EXCEEDED']);
    await service.submit(record.id, preparer);
    await expect(service.approve(record.id, 'ok', approver)).rejects.toMatchObject({
      response: { code: 'ACCEPTANCE_CAP_EXCEEDED' },
    });

    // Taking a project off brings it under the ceiling (80% warning only).
    await service.returnRecord(record.id, 'Bớt dự án', approver);
    const [first] = record.sources;
    const trimmed = await service.update(
      record.id,
      { excludedProjectIds: [first.projectId] },
      preparer,
    );
    expect(trimmed).toMatchObject({
      grossAmount: 5_000_000,
      excludedProjectIds: [first.projectId],
    });
    expect(trimmed.warnings.map((warning) => warning.code)).toEqual(['CAP_80_PERCENT']);
  });

  it('lists only the records of contracts one manages, without read_all', async () => {
    const own = await service.list(new ListAcceptancesQueryDto(), preparer);
    expect(own.total).toBeGreaterThan(0);
    const other = await service.list(new ListAcceptancesQueryDto(), {
      ...preparer,
      userId: 'nobody',
    });
    expect(other.total).toBe(0);
    await expect(
      service.get(own.items[0].id, { ...preparer, userId: 'nobody' }),
    ).rejects.toMatchObject({
      response: { code: 'ACCEPTANCE_NOT_FOUND' },
    });
  });

  it('refuses a record for a contract that is not active', async () => {
    const partner = await fixtures.partner(preparer.userId);
    const contractId = await fixtures.contract(partner.id, preparer.userId, {
      pricingModel: 'per_topic',
      pricingConfig: { unit_price: 1, min_topic_minutes: 1 },
      status: 'suspended',
    });
    await expect(
      service.create(contractId, { periodStart: '2026-09-01', periodEnd: '2026-09-30' }, preparer),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_ACTIVE' } });
    await expect(
      service.create(contractId, { periodStart: '2026-09-30', periodEnd: '2026-09-01' }, preparer),
    ).rejects.toMatchObject({ response: { code: 'ACCEPTANCE_PERIOD_INVALID' } });
  });
});
