/**
 * DB-level tests of partners and contracts (ANTGO-251): constraints of the migration, list filters,
 * BR-05 numbering against existing rows, the issue → activate flow with the encrypted snapshot,
 * amendments and the legacy import. AG Account is mocked. Runs against real Postgres (see
 * footage.db-spec.ts for the setup).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { AppDataSource } from '../../database/data-source';
import { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import { ContractEntity } from '../../database/entities/contract.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import type { AccountApiService } from '../account/account-api.service';
import type { AccountContractProfile } from '../account/account.types';
import { documentsStub } from '../documents/testing/documents-stub';
import type { SystemLogService } from '../logs/system-log.service';
import { ListPartnersQueryDto } from '../partners/dto/partner.dto';
import type { PartnerActor } from '../partners/partner-actor';
import { PartnersService } from '../partners/partners.service';
import { ContractsService, type PartnerSnapshot } from './contracts.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
// The ESM build of uuid does not load under ts-jest.
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

const suffix = randomUUID()
  .slice(0, 6)
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, 'X');
const manager: PartnerActor = {
  userId: `mgr-${suffix}`,
  userType: 'USER',
  permissions: ['go.partner.read', 'go.partner.manage', 'go.contract.read', 'go.contract.manage'],
};

function profile(accountUserId: string): AccountContractProfile {
  return {
    user_id: accountUserId,
    name: 'Nguyễn Hữu Hoàng',
    citizen_id_number: '035086000130',
    id_issued_date: '2021-05-01',
    id_issued_place: 'Cục CS',
    tax_number: '035086000130',
    phone_number: '0912345678',
    birthday: '1986-02-03',
    address: null,
    permanent_address: 'Hà Nam',
    passport_number: null,
    contract_number: null,
    contract_date: null,
    bank_account_name: 'NGUYEN HUU HOANG',
    bank_account_number: '0011006167',
    bank_code: '970436',
    bank_name: 'Vietcombank',
    tax_mode: 'WITHHOLD_10',
    bank_account_last4: '6167',
    passport_unreadable: false,
    bank_account_unreadable: false,
    updated_at: null,
    version: 'v-1',
  };
}

let ds: DataSource;
let partners: PartnersService;
let contracts: ContractsService;
let cipher: PiiCipherService;
const accountApi = {
  resolveBySub: jest.fn(async (sub: string) => ({
    user_id: `acc-${sub.split('|')[1]}`.slice(0, 36),
    user_type: 'USER',
    permissions: ['go.project.edit'],
    is_active: true,
  })),
  getUsersByIds: jest.fn(
    async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: 'Nguyễn Hữu Hoàng' }])),
  ),
  getContractProfile: jest.fn(async (accountUserId: string) => profile(accountUserId)),
};

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
  const key = randomBytes(32).toString('base64');
  cipher = new PiiCipherService({
    get: (name: string) => (name === 'PARTNER_PII_ENCRYPTION_KEY' ? key : undefined),
  } as never);
  partners = new PartnersService(
    ds.getRepository(PartnerEntity),
    accountApi as unknown as AccountApiService,
    systemLog as unknown as SystemLogService,
  );
  contracts = new ContractsService(
    ds,
    ds.getRepository(ContractEntity),
    ds.getRepository(ContractAmendmentEntity),
    ds.getRepository(PartnerEntity),
    partners,
    cipher,
    systemLog as unknown as SystemLogService,
    documentsStub(),
  );
});

afterAll(async () => {
  if (ds?.isInitialized) {
    await ds.query(`DELETE FROM partners WHERE manager_user_id = $1`, [manager.userId]);
    await ds.destroy();
  }
});

afterEach(async () => {
  await ds.query(
    `DELETE FROM contracts WHERE partner_id IN (SELECT id FROM partners WHERE manager_user_id = $1)`,
    [manager.userId],
  );
  await ds.query(`DELETE FROM partners WHERE manager_user_id = $1`, [manager.userId]);
});

async function createPartner(goUserId: string, code?: string) {
  return partners.create({ goUserId, code }, manager);
}

describe('partners (DB)', () => {
  it('generates distinct codes and keeps one partner per user', async () => {
    const first = await createPartner(`u1-${suffix}`, `Q${suffix}`);
    const second = await createPartner(`u2-${suffix}`, `Q${suffix}2`);
    expect(first.code).toBe(`Q${suffix}`);
    expect(second.code).toBe(`Q${suffix}2`);

    await expect(createPartner(`u1-${suffix}`)).rejects.toMatchObject({
      response: { code: 'PARTNER_ALREADY_EXISTS' },
    });
    await expect(
      ds.query(
        `INSERT INTO partners (id, account_user_id, go_user_id, code, display_name, manager_user_id, created_by)
         VALUES ($1, $2, $3, $4, 'x', 'm', 'm')`,
        [randomUUID(), first.accountUserId, `other-${suffix}`, `Z${suffix}`],
      ),
    ).rejects.toThrow(/partners_account_user_id_key/);
  });

  it('filters by profile state and keyword, scoped to the manager', async () => {
    const checked = await createPartner(`u3-${suffix}`, `K${suffix}`);
    await createPartner(`u4-${suffix}`, `L${suffix}`);
    await partners.getProfile(checked.id, false, manager);

    const complete = await partners.list(
      Object.assign(new ListPartnersQueryDto(), { profile: 'complete' }),
      manager,
    );
    expect(complete.items.map((item) => item.id)).toEqual([checked.id]);
    expect(complete.items[0]).toMatchObject({ profileState: 'complete', activeContractCount: 0 });

    const byKeyword = await partners.list(
      Object.assign(new ListPartnersQueryDto(), { keyword: `l${suffix}` }),
      manager,
    );
    expect(byKeyword.total).toBe(1);

    const other = await partners.list(new ListPartnersQueryDto(), {
      ...manager,
      userId: 'someone-else',
    });
    expect(other.items.find((item) => item.id === checked.id)).toBeUndefined();
  });
});

describe('contracts (DB)', () => {
  const terms = {
    startDate: '2026-08-01',
    pricingModel: 'per_unit' as const,
    pricingConfig: { unit: 'shot', unit_price: 300_000 },
    acceptanceCycle: 'monthly' as const,
    paymentTermBusinessDays: 10,
    capAmount: 50_000_000,
  };

  it('numbers by BR-05 with -2 on the same day, then issues, activates and amends', async () => {
    const partner = await createPartner(`u5-${suffix}`, `C${suffix}`);
    const first = await contracts.create({ partnerId: partner.id, ...terms }, manager);
    const second = await contracts.create({ partnerId: partner.id, ...terms }, manager);
    expect(first.contractNumber).toBe(`010826/HĐSXND/AG-C${suffix}`);
    expect(second.contractNumber).toBe(`010826/HĐSXND/AG-C${suffix}-2`);
    expect(first.capAmount).toBe(50_000_000);
    expect(first.penaltyPercent).toBe(8);

    const issued = await contracts.issue(first.id, manager);
    expect(issued).toMatchObject({ status: 'issued', hasPartnerSnapshot: true });
    expect(issued).not.toHaveProperty('partnerSnapshotEnc');
    const [{ enc }] = (await ds.query(
      `SELECT partner_snapshot_enc AS enc FROM contracts WHERE id = $1`,
      [first.id],
    )) as Array<{ enc: string }>;
    expect(enc).not.toContain('035086000130');
    expect(cipher.decryptJson<PartnerSnapshot>(enc).fields.citizenIdNumber).toBe('035086000130');

    await expect(contracts.update(first.id, { capAmount: 1 }, manager)).rejects.toMatchObject({
      response: { code: 'CONTRACT_TERMS_LOCKED' },
    });
    const active = await contracts.activate(
      first.id,
      { signedDate: '2026-08-01', signedFileId: randomUUID() },
      manager,
    );
    expect(active.status).toBe('active');

    const amendment = await contracts.createAmendment(
      first.id,
      { effectiveDate: '2026-10-01', changes: { capAmount: 90_000_000 }, reason: 'Nâng trần' },
      manager,
    );
    expect(amendment).toMatchObject({ amendmentNumber: 1, status: 'draft' });
    await contracts.issueAmendment(first.id, amendment.id, manager);
    await contracts.signAmendment(first.id, amendment.id, undefined, manager);
    await expect(contracts.terms(first.id, '2026-09-30', manager)).resolves.toMatchObject({
      cap_amount: 50_000_000,
    });
    await expect(contracts.terms(first.id, '2026-10-01', manager)).resolves.toMatchObject({
      cap_amount: 90_000_000,
      appliedAmendments: [1],
    });

    const listed = await partners.get(partner.id, manager);
    expect(listed.activeContractCount).toBe(1);
  });

  it('refuses an advance above the ceiling', async () => {
    const partner = await createPartner(`u6-${suffix}`, `D${suffix}`);
    await expect(
      contracts.create(
        { partnerId: partner.id, ...terms, advanceAmount: 60_000_000, advanceDueBusinessDays: 5 },
        manager,
      ),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_TERMS_INVALID' } });
  });

  it('imports legacy contracts all or nothing, continuing their appendix numbers', async () => {
    await createPartner(`u7-${suffix}`, `E${suffix}`);
    const header =
      'partner_code,contract_number,signed_date,start_date,end_date,status,pricing_model,pricing_config,acceptance_cycle,payment_term_business_days,cap_amount,advance_amount,advance_due_business_days,last_appendix_number,legacy_accepted_amount,legacy_paid_amount,legacy_advance_balance,note';
    const config = '"{""unit"":""shot"",""unit_price"":300000}"';
    const row = (number: string, code = `E${suffix}`) =>
      `${code},${number},06/06/2026,06/06/2026,,active,per_unit,${config},monthly,10,72500000,0,,4,15000000,,,`;
    const file = (content: string) => {
      const buffer = Buffer.from(content, 'utf8');
      return { buffer, mimetype: 'text/csv', originalname: 'contracts.csv', size: buffer.length };
    };

    const failed = await contracts.importCsv(
      file(`${header}\n${row(`060626/AG-E${suffix}`)}\n${row(`X-${suffix}`, 'NOPE')}`),
      manager,
    );
    expect(failed).toMatchObject({ inserted: 0, failed: 1 });
    expect(failed.errors[0]).toMatchObject({ row: 3, field: 'partner_code' });

    const ok = await contracts.importCsv(
      file(`${header}\n${row(`060626/AG-E${suffix}`)}`),
      manager,
    );
    expect(ok).toEqual({ totalRows: 1, inserted: 1, failed: 0, errors: [] });
    const [imported] = await ds
      .getRepository(ContractEntity)
      .find({ where: { contractNumber: `060626/AG-E${suffix}` } });
    expect(imported).toMatchObject({
      source: 'legacy_import',
      status: 'active',
      lastAppendixNumber: 4,
      capAmount: 72_500_000,
      legacyAcceptedAmount: 15_000_000,
    });
    const view = await contracts.get(imported.id, manager);
    expect(view.nextAppendixNumber).toBe(5);

    const again = await contracts.importCsv(
      file(`${header}\n${row(`060626/AG-E${suffix}`)}`),
      manager,
    );
    expect(again.errors[0]).toMatchObject({ field: 'contract_number' });
  });
});
