/**
 * DB-level tests of payments (ANTGO-254, spec 6.6, 6.8 TC-4, 7.8, BR-32…35): the advance balance
 * from advances actually paid, TC-4 end to end (offset 16.470.000, nothing to pay, 33.530.000 left,
 * refunded when the contract is terminated), advance → acceptance record → partial payments → paid,
 * cancellations, overdue records, the ledger, reports and Excel exports. AG Account and R2 are
 * stubbed; runs against real Postgres.
 */
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { AppDataSource } from '../../database/data-source';
import { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import { ContractEntity } from '../../database/entities/contract.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { AcceptancesService } from '../acceptances/acceptances.service';
import { ContractFixtures } from '../acceptances/testing/db-fixtures';
import type { StorageAdapter } from '../assets/storage/storage-adapter';
import { ContractsService } from '../contracts/contracts.service';
import { documentsStub } from '../documents/testing/documents-stub';
import type { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import type { PartnersService } from '../partners/partners.service';
import { ListPaymentsQueryDto } from './dto/payment.dto';
import { PaymentReportsService } from './payment-reports.service';
import { PaymentsService } from './payments.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

let ds: DataSource;
let fixtures: ContractFixtures;
let contracts: ContractsService;
let acceptances: AcceptancesService;
let payments: PaymentsService;
let reports: PaymentReportsService;
const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
const partners = {
  readProfileForDocument: jest.fn().mockResolvedValue({
    profile: {
      version: '7',
      name: 'Nguyễn Văn Cường',
      citizen_id_number: '035086000030',
      tax_number: '8123456789',
      bank_account_number: '0011004455667',
      bank_account_name: 'NGUYEN VAN CUONG',
      bank_name: 'Vietcombank',
    },
    completeness: { complete: true, missing: [] },
  }),
};
/** Readable "encryption" so the payout export can read the snapshot back. */
const cipher = {
  encryptJson: (value: unknown) => `t:${Buffer.from(JSON.stringify(value)).toString('base64')}`,
  decryptJson: (value: string) => JSON.parse(Buffer.from(value.slice(2), 'base64').toString()),
};
const objects = new Map<string, Buffer>();
const storage = {
  putObject: async (key: string, body: Buffer) => {
    objects.set(key, body);
    return { sizeBytes: body.length };
  },
  readObject: (key: string) => Readable.from([objects.get(key)!]),
} as unknown as StorageAdapter;

const preparer: PartnerActor = {
  userId: 'pay-manager',
  userType: 'USER',
  permissions: ['go.contract.read', 'go.acceptance.prepare'],
};
const approver: PartnerActor = {
  userId: 'pay-approver',
  userType: 'USER',
  permissions: ['go.contract.read', 'go.contract.read_all', 'go.acceptance.approve'],
};
const accountant: PartnerActor = {
  userId: 'pay-accountant',
  userType: 'USER',
  permissions: [
    'go.contract.read',
    'go.contract.read_all',
    'go.contract.manage',
    'go.payment.manage',
    'go.partner.pii_read',
  ],
};

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  fixtures = new ContractFixtures(ds);
  await fixtures.setup();
  const documents = documentsStub();
  contracts = new ContractsService(
    ds,
    ds.getRepository(ContractEntity),
    ds.getRepository(ContractAmendmentEntity),
    ds.getRepository(PartnerEntity),
    partners as unknown as PartnersService,
    cipher as unknown as PiiCipherService,
    systemLog as unknown as SystemLogService,
    documents,
  );
  acceptances = new AcceptancesService(
    ds,
    contracts,
    partners as unknown as PartnersService,
    cipher as unknown as PiiCipherService,
    systemLog as unknown as SystemLogService,
    documents,
  );
  payments = new PaymentsService(
    ds,
    contracts,
    acceptances,
    cipher as unknown as PiiCipherService,
    systemLog as unknown as SystemLogService,
    storage,
  );
  reports = new PaymentReportsService(ds, payments, systemLog as unknown as SystemLogService);
});

afterAll(async () => {
  if (ds?.isInitialized) {
    await fixtures.cleanup();
    await ds.destroy();
  }
});

/** A per_unit contract (300.000 / shot ≥ 60 s) with 61 approved shots delivered in September. */
async function shotContract(advanceAmount: number, capAmount = 100_000_000) {
  const partner = await fixtures.partner(preparer.userId);
  const contractId = await fixtures.contract(partner.id, preparer.userId, {
    pricingModel: 'per_unit',
    pricingConfig: { unit: 'shot', unit_price: 300_000, min_shot_seconds: 60 },
    capAmount,
    advanceAmount,
  });
  const projectId = await fixtures.project(partner.goUserId, {
    contractId,
    deliveredAt: '2026-09-20T03:00:00Z',
  });
  await fixtures.videos(projectId, Array(61).fill(75), 'approved');
  return { partner, contractId };
}

async function draft(contractId: string) {
  return acceptances.create(
    contractId,
    { periodStart: '2026-09-01', periodEnd: '2026-09-30', recordDate: '2026-10-07' },
    preparer,
  );
}

/** draft → submitted → approved → issued → signed on 09/10/2026 (due 23/10/2026). */
async function issueAndSign(id: string) {
  await acceptances.submit(id, preparer);
  await acceptances.approve(id, undefined, approver);
  await acceptances.issue(id, approver);
  return acceptances.sign(id, { signedDate: '2026-10-09' }, approver);
}

function auditActions() {
  return systemLog.write.mock.calls.map(([entry]) => (entry as { action: string }).action);
}

describe('TC-4: advance 50.000.000, full_first offset', () => {
  it('offsets 16.470.000 from the advance paid, pays 0, keeps 33.530.000 and refunds it on termination', async () => {
    const { contractId } = await shotContract(50_000_000);

    const advance = await payments.create(
      contractId,
      { kind: 'advance', amount: 50_000_000, paidDate: '2026-08-05', reference: 'FT2608' },
      accountant,
    );
    expect(advance).toMatchObject({
      kind: 'advance',
      amount: 50_000_000,
      status: 'recorded',
      method: 'bank_transfer',
      acceptanceId: null,
      hasProof: false,
    });
    await expect(
      payments.create(
        contractId,
        { kind: 'advance', amount: 1, paidDate: '2026-08-05' },
        accountant,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_ADVANCE_EXCEEDS_AGREED', details: { room: 0 } },
    });

    const record = await draft(contractId);
    expect(record).toMatchObject({
      grossAmount: 18_300_000,
      taxAmount: 1_830_000,
      advanceOffsetAmount: 16_470_000,
      netPayable: 0,
    });
    const signed = await issueAndSign(record.id);
    // Nothing to pay: paid once signed (FR-$-02).
    expect(signed).toMatchObject({ status: 'paid', dueDate: '2026-10-23' });
    await expect(
      payments.create(
        contractId,
        { kind: 'settlement', acceptanceId: record.id, amount: 1, paidDate: '2026-10-10' },
        accountant,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_ACCEPTANCE_NOT_PAYABLE' } });

    const ledger = await payments.ledger(contractId, accountant);
    expect(ledger).toMatchObject({
      acceptedAmount: 18_300_000,
      taxAmount: 1_830_000,
      advanceOffsetAmount: 16_470_000,
      netPayable: 0,
      advancesPaid: 50_000_000,
      advanceBalance: 33_530_000,
      outstanding: 0,
      refundDue: 0,
      capRatio: 0.183,
      capAlert: 'none',
      balanced: true,
    });
    expect(ledger.records).toHaveLength(1);
    expect(ledger.payments.map((payment) => payment.kind)).toEqual(['advance']);

    // Offset on an issued record: the advance cannot be cancelled any more.
    await expect(payments.cancel(advance.id, 'Nhầm', accountant)).rejects.toMatchObject({
      response: { code: 'PAYMENT_ADVANCE_ALREADY_OFFSET' },
    });

    // FR-C-10 / BR-35: terminated with 33.530.000 left → the partner returns it.
    await contracts.terminate(contractId, 'Đối tác xin dừng', accountant);
    const closed = await payments.ledger(contractId, accountant);
    expect(closed).toMatchObject({
      advanceBalance: 33_530_000,
      refundDue: 33_530_000,
      penaltyReference: 8_000_000,
    });
    await expect(
      payments.create(
        contractId,
        { kind: 'refund', amount: 33_530_001, paidDate: '2026-10-20' },
        accountant,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_REFUND_EXCEEDS_BALANCE', details: { balance: 33_530_000 } },
    });
    await expect(
      payments.create(
        contractId,
        { kind: 'advance', amount: 1, paidDate: '2026-10-20' },
        accountant,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_CONTRACT_STATUS' } });
    await payments.create(
      contractId,
      { kind: 'refund', amount: 33_530_000, paidDate: '2026-10-20', reference: 'HOAN-01' },
      accountant,
    );
    expect(await payments.ledger(contractId, accountant)).toMatchObject({
      advanceBalance: 0,
      refundDue: 0,
      refunds: 33_530_000,
      totalPaid: 16_470_000,
    });
  });
});

describe('advance → acceptance record → payments → paid', () => {
  it('recomputes drafts on the advance, pays in parts, cancels, reports and exports', async () => {
    const { partner, contractId } = await shotContract(10_000_000);
    const record = await draft(contractId);
    expect(record).toMatchObject({ advanceOffsetAmount: 0, netPayable: 16_470_000 });

    await expect(
      payments.create(
        contractId,
        { kind: 'advance', amount: 10_000_000, paidDate: '2026-08-05' },
        preparer,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_FORBIDDEN' } });
    await expect(
      payments.create(
        contractId,
        { kind: 'advance', amount: 10_000_000, paidDate: '2999-01-01' },
        accountant,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_DATE_IN_FUTURE' } });
    await payments.create(
      contractId,
      { kind: 'advance', amount: 10_000_000, paidDate: '2026-08-05' },
      accountant,
    );
    // The draft was priced again with the advance paid.
    expect(await acceptances.get(record.id, preparer)).toMatchObject({
      advanceOffsetAmount: 10_000_000,
      netPayable: 6_470_000,
    });

    await acceptances.submit(record.id, preparer);
    await acceptances.approve(record.id, undefined, approver);
    await acceptances.issue(record.id, approver);
    await expect(
      payments.create(
        contractId,
        { kind: 'settlement', acceptanceId: record.id, amount: 1_000, paidDate: '2026-10-08' },
        accountant,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_ACCEPTANCE_NOT_PAYABLE', details: { status: 'issued' } },
    });
    const signed = await acceptances.sign(record.id, { signedDate: '2026-10-09' }, approver);
    expect(signed).toMatchObject({ status: 'signed', dueDate: '2026-10-23' });

    const first = await payments.create(
      contractId,
      { kind: 'settlement', acceptanceId: record.id, amount: 3_000_000, paidDate: '2026-10-15' },
      accountant,
    );
    expect(first).toMatchObject({ kind: 'settlement', acceptanceId: record.id, appendixNumber: 1 });
    expect((await acceptances.get(record.id, preparer)).status).toBe('partially_paid');
    await expect(
      payments.create(
        contractId,
        { kind: 'settlement', acceptanceId: record.id, amount: 3_470_001, paidDate: '2026-10-20' },
        accountant,
      ),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_EXCEEDS_REMAINING', details: { remaining: 3_470_000 } },
    });
    await expect(
      payments.create(
        contractId,
        { kind: 'settlement', amount: 1, paidDate: '2026-10-20' },
        accountant,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_ACCEPTANCE_REQUIRED' } });

    // Overdue after 23/10 with 3.470.000 left (BR-34, FR-$-03).
    const overdue = await payments.overdue({ contractId, asOf: '2026-11-03' }, accountant);
    expect(overdue).toMatchObject({ count: 1, amount: 3_470_000 });
    expect(overdue.items[0]).toMatchObject({
      id: record.id,
      remaining: 3_470_000,
      overdueDays: 11,
    });
    expect((await payments.overdue({ contractId, asOf: '2026-10-23' }, accountant)).count).toBe(0);

    // Payout export (FR-$-05): masked without reveal, in full with it.
    const masked = await readSheet(
      (await payments.exportPayouts({ contractId }, accountant)).buffer,
    );
    expect(masked[4]).toEqual(
      expect.arrayContaining(['Nguyễn Văn Cường', '8123****89', '****5667', 'Vietcombank']),
    );
    expect(masked[4]).toEqual(expect.arrayContaining([6_470_000, 3_000_000, 3_470_000, 11]));
    const full = await readSheet(
      (await payments.exportPayouts({ contractId, reveal: true }, accountant)).buffer,
    );
    expect(full[4]).toEqual(expect.arrayContaining(['8123456789', '0011004455667']));
    await expect(
      payments.exportPayouts(
        { contractId, reveal: true },
        { ...accountant, permissions: ['go.contract.read', 'go.payment.manage'] },
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_FORBIDDEN' } });

    const second = await payments.create(
      contractId,
      { kind: 'settlement', acceptanceId: record.id, amount: 3_470_000, paidDate: '2026-10-25' },
      accountant,
    );
    expect((await acceptances.get(record.id, preparer)).status).toBe('paid');

    // Cancelled with a reason: back to partially_paid, never deleted.
    const cancelled = await payments.cancel(first.id, 'Sai số tài khoản', accountant);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelledReason: 'Sai số tài khoản',
      cancelledBy: accountant.userId,
    });
    await expect(payments.cancel(first.id, 'Lần nữa', accountant)).rejects.toMatchObject({
      response: { code: 'PAYMENT_ALREADY_CANCELLED' },
    });
    expect((await acceptances.get(record.id, preparer)).status).toBe('partially_paid');
    expect(await payments.ledger(contractId, accountant)).toMatchObject({
      settlementsPaid: 3_470_000,
      outstanding: 3_000_000,
      advanceBalance: 0,
    });
    await payments.create(
      contractId,
      {
        kind: 'settlement',
        acceptanceId: record.id,
        amount: 3_000_000,
        paidDate: '2026-10-26',
        method: 'bank_transfer',
        reference: 'FT2610',
        note: 'Chi lại',
      },
      accountant,
    );
    expect((await acceptances.get(record.id, preparer)).status).toBe('paid');
    expect(await payments.ledger(contractId, accountant)).toMatchObject({
      netPayable: 6_470_000,
      settlementsPaid: 6_470_000,
      outstanding: 0,
      totalPaid: 16_470_000,
      overdueCount: 0,
    });

    // Transfer proof in R2, read back through the API.
    const withProof = await payments.uploadProof(
      second.id,
      { originalname: 'uy-nhiem-chi.png', size: 4, buffer: Buffer.from('png!') },
      accountant,
    );
    expect(withProof).toMatchObject({ hasProof: true, proofContentType: 'image/png' });
    expect(withProof).not.toHaveProperty('proofStorageKey');
    expect((await payments.proofContent(second.id, accountant)).buffer.toString()).toBe('png!');
    await expect(
      payments.uploadProof(
        second.id,
        { originalname: 'x.exe', size: 4, buffer: Buffer.from('MZ!!') },
        accountant,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_PROOF_INVALID' } });

    const list = await payments.list(
      Object.assign(new ListPaymentsQueryDto(), { contractId }),
      accountant,
    );
    expect(list.total).toBe(4);
    expect(list.items.map((item) => [item.kind, item.amount, item.status])).toEqual([
      ['settlement', 3_000_000, 'recorded'],
      ['settlement', 3_470_000, 'recorded'],
      ['settlement', 3_000_000, 'cancelled'],
      ['advance', 10_000_000, 'recorded'],
    ]);
    expect(auditActions()).toEqual(
      expect.arrayContaining([
        'PAYMENT_RECORDED',
        'PAYMENT_CANCELLED',
        'PAYMENT_PROOF_UPLOADED',
        'PAYMENT_PROOF_VIEWED',
        'PAYOUTS_EXPORTED',
      ]),
    );

    // Reports (spec 6.7).
    const payables = await reports.payables({ contractId }, accountant);
    expect(payables.contracts).toHaveLength(1);
    expect(payables.contracts[0]).toMatchObject({
      partnerId: partner.id,
      acceptedAmount: 18_300_000,
      taxAmount: 1_830_000,
      netPayable: 6_470_000,
      settlementsPaid: 6_470_000,
      advancesPaid: 10_000_000,
      advanceBalance: 0,
      outstanding: 0,
    });
    expect(payables.partners[0]).toMatchObject({ contracts: 1, acceptedAmount: 18_300_000 });

    const byPeriod = await reports.paymentsByPeriod(
      { contractId, from: '2026-08-01', to: '2026-10-31' },
      accountant,
    );
    expect(byPeriod.periods).toEqual([
      { period: '2026-08', advance: 10_000_000, settlement: 0, refund: 0, netOut: 10_000_000 },
      { period: '2026-10', advance: 0, settlement: 6_470_000, refund: 0, netOut: 6_470_000 },
    ]);
    expect(byPeriod.totals.netOut).toBe(16_470_000);

    const byStatus = await reports.acceptancesByStatus(
      { contractId, from: '2026-10-01', to: '2026-10-31' },
      accountant,
    );
    expect(byStatus.byStatus).toEqual([
      expect.objectContaining({ status: 'paid', count: 1, netPayable: 6_470_000, remaining: 0 }),
    ]);

    const tax = await reports.taxByPartner({ year: 2026, partnerId: partner.id }, accountant);
    expect(tax.partners).toEqual([
      expect.objectContaining({ partnerId: partner.id, records: 1, taxAmount: 1_830_000 }),
    ]);

    for (const report of ['payables', 'payments', 'acceptances', 'tax'] as const) {
      const file = await reports.exportXlsx(
        { report, contractId, partnerId: partner.id, year: 2026 },
        accountant,
      );
      expect((await readSheet(file.buffer)).length).toBeGreaterThan(4);
    }
  });
});

describe('advance changes after a record was priced', () => {
  it('blocks issuing a record that offsets advance no longer paid', async () => {
    const { contractId } = await shotContract(10_000_000);
    const advance = await payments.create(
      contractId,
      { kind: 'advance', amount: 10_000_000, paidDate: '2026-08-05' },
      accountant,
    );
    const record = await draft(contractId);
    expect(record.advanceOffsetAmount).toBe(10_000_000);
    await acceptances.submit(record.id, preparer);
    await acceptances.approve(record.id, undefined, approver);

    // Not issued yet: the advance can still be cancelled…
    await payments.cancel(advance.id, 'Chưa chuyển khoản', accountant);
    // …and the record then cannot be issued with its offset.
    await expect(acceptances.issue(record.id, approver)).rejects.toMatchObject({
      response: {
        code: 'ACCEPTANCE_ADVANCE_OFFSET_EXCEEDS_BALANCE',
        details: { advanceOffsetAmount: 10_000_000, available: 0 },
      },
    });
  });

  it('hides the ledger of contracts one does not manage', async () => {
    const { contractId } = await shotContract(0);
    await expect(
      payments.ledger(contractId, {
        userId: 'someone-else',
        userType: 'USER',
        permissions: ['go.contract.read'],
      }),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_FOUND' } });
    await expect(
      payments.create(
        contractId,
        { kind: 'advance', amount: 1, paidDate: '2026-08-05' },
        accountant,
      ),
    ).rejects.toMatchObject({ response: { code: 'PAYMENT_ADVANCE_NOT_AGREED' } });
  });
});

async function readSheet(buffer: Buffer): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const rows: unknown[][] = [];
  workbook.worksheets[0].eachRow({ includeEmpty: true }, (row) => {
    rows.push((row.values as unknown[]).slice(1));
  });
  return rows;
}
