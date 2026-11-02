/**
 * DB-level tests of contract documents (ANTGO-253, spec 6.5, 7.9, 13): templates (upload check,
 * versions, active one, interim templates), party A settings and their snapshot (FR-D-05), the check
 * before issue (FR-D-03), the worker render from the stored snapshots (DOCX, PDF through a mocked
 * Gotenberg), reading files back, previews, signed copies and regeneration. R2, Redis, Gotenberg
 * and AG Account are mocked; runs against real Postgres with the migrations.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { AppDataSource } from '../../database/data-source';
import { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import { ContractEntity } from '../../database/entities/contract.entity';
import { DocumentTemplateEntity } from '../../database/entities/document-template.entity';
import { GeneratedDocumentEntity } from '../../database/entities/generated-document.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { SystemSettingEntity } from '../../database/entities/system-setting.entity';
import type { DocumentQueueService } from '../../infra/queue/document-queue.service';
import { ContractFixtures } from '../acceptances/testing/db-fixtures';
import type { AccountContractProfile } from '../account/account.types';
import type { StorageAdapter } from '../assets/storage/storage-adapter';
import { buildPartnerSnapshot, ContractsService } from '../contracts/contracts.service';
import type { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import type { PartnersService } from '../partners/partners.service';
import { CompanySettingsService } from './company-settings.service';
import { DocumentTemplatesService } from './document-templates.service';
import { DocumentsService } from './documents.service';
import { buildDocx, p } from './docx-builder';
import { docxText } from './docx-renderer';
import type { GotenbergClient } from './gotenberg.client';
import { PdfConversionError } from './gotenberg.client';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

const actor: PartnerActor = {
  userId: 'docs-manager',
  userType: 'USER',
  permissions: [
    'go.contract.read',
    'go.contract.manage',
    'go.contract.template_manage',
    'go.acceptance.approve',
  ],
};

function accountProfile(overrides: Partial<AccountContractProfile> = {}): AccountContractProfile {
  return {
    user_id: 'acc-1',
    name: 'Nguyễn Hữu Hoàng',
    citizen_id_number: '035086000030',
    id_issued_date: '2021-08-10',
    id_issued_place: 'Cục CS QLHC về TTXH',
    tax_number: '8012345678',
    phone_number: '0912345678',
    birthday: '1986-03-04',
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
    ...overrides,
  };
}

/** R2 in memory. */
const objects = new Map<string, Buffer>();
const storage = {
  putObject: jest.fn(async (key: string, body: Buffer) => {
    objects.set(key, Buffer.from(body));
    return { sizeBytes: body.length };
  }),
  readObject: jest.fn((key: string) => {
    const body = objects.get(key);
    if (!body) {
      return new Readable({
        read() {
          this.destroy(new Error(`NoSuchKey ${key}`));
        },
      });
    }
    return Readable.from([body]);
  }),
} as unknown as StorageAdapter;

let gotenbergOn = true;
const gotenberg = {
  isConfigured: () => gotenbergOn,
  convertDocx: jest.fn(async (docx: Buffer) => Buffer.from(`%PDF-1.7 ${docx.length}`)),
};
const queue = { addJob: jest.fn().mockResolvedValue(undefined) };
const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
let profile = accountProfile();
const partners = {
  readProfileForDocument: jest.fn(async () => ({
    profile,
    completeness: { complete: true, missing: [] },
  })),
};

let ds: DataSource;
let fixtures: ContractFixtures;
let cipher: PiiCipherService;
let templates: DocumentTemplatesService;
let company: CompanySettingsService;
let documents: DocumentsService;
let contracts: ContractsService;
let partnerId: string;

const COMPANY = {
  name: 'CÔNG TY CỔ PHẦN ANT GROUP',
  taxCode: '0109999999',
  representative: 'Ông Nguyễn Văn A',
  title: 'Giám đốc',
  address: 'Số 1 Phố Mẫu, Hà Nội',
};

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  await ds.query(`DELETE FROM generated_documents`);
  await ds.query(`DELETE FROM document_templates`);
  await ds.query(`UPDATE system_settings SET value = '{}'::jsonb WHERE key = 'company'`);
  fixtures = new ContractFixtures(ds);
  await fixtures.setup();
  const key = randomBytes(32).toString('base64');
  cipher = new PiiCipherService({
    get: (name: string) => (name === 'PARTNER_PII_ENCRYPTION_KEY' ? key : undefined),
  } as never);
  templates = new DocumentTemplatesService(
    ds,
    ds.getRepository(DocumentTemplateEntity),
    storage,
    systemLog as unknown as SystemLogService,
  );
  company = new CompanySettingsService(ds.getRepository(SystemSettingEntity));
  documents = new DocumentsService(
    ds,
    ds.getRepository(GeneratedDocumentEntity),
    storage,
    templates,
    company,
    cipher,
    gotenberg as unknown as GotenbergClient,
    queue as unknown as DocumentQueueService,
    systemLog as unknown as SystemLogService,
  );
  contracts = new ContractsService(
    ds,
    ds.getRepository(ContractEntity),
    ds.getRepository(ContractAmendmentEntity),
    ds.getRepository(PartnerEntity),
    partners as unknown as PartnersService,
    cipher,
    systemLog as unknown as SystemLogService,
    documents,
  );
  partnerId = (await fixtures.partner(actor.userId)).id;
});

afterAll(async () => {
  if (ds?.isInitialized) {
    await fixtures.cleanup();
    await ds.query(`DELETE FROM document_templates`);
    await ds.query(`UPDATE system_settings SET value = '{}'::jsonb WHERE key = 'company'`);
    await ds.destroy();
  }
});

beforeEach(() => {
  profile = accountProfile();
  gotenbergOn = true;
  queue.addJob.mockClear();
  systemLog.write.mockClear();
});

async function topicContract(status = 'draft') {
  return fixtures.contract(partnerId, actor.userId, {
    status,
    pricingModel: 'per_topic',
    pricingConfig: { unit_price: 2_500_000, min_topic_minutes: 20, require_audio: true },
    capAmount: 100_000_000,
    techSpec: { min_width: 1920, min_height: 1080, require_audio: true },
  });
}

function upload(buffer: Buffer, name = 'mau.docx') {
  return { originalname: name, size: buffer.length, buffer };
}

async function generatedOf(ownerId: string) {
  return ds
    .getRepository(GeneratedDocumentEntity)
    .find({ where: { ownerId, kind: 'generated' }, order: { version: 'ASC' } });
}

async function contentText(document: GeneratedDocumentEntity) {
  const content = await documents.content(document, 'docx', actor);
  return docxText(content.buffer);
}

describe('company settings (FR-D-05)', () => {
  it('reports missing party A fields and refuses a snapshot until complete', async () => {
    const view = await company.get();
    expect(view.complete).toBe(false);
    expect(view.missing).toEqual(['name', 'taxCode', 'representative', 'title', 'address']);
    await expect(company.snapshot()).rejects.toMatchObject({
      response: { code: 'COMPANY_PROFILE_INCOMPLETE' },
    });
  });

  it('blocks issue before anything is taken when party A is incomplete', async () => {
    const contractId = await topicContract();
    await expect(contracts.issue(contractId, actor)).rejects.toMatchObject({
      response: { code: 'COMPANY_PROFILE_INCOMPLETE' },
    });
    const [row] = (await ds.query(`SELECT status FROM contracts WHERE id = $1`, [
      contractId,
    ])) as Array<{
      status: string;
    }>;
    expect(row.status).toBe('draft');
  });

  it('saves the fields sent, trimmed, null clears', async () => {
    const view = await company.update({ ...COMPANY, phone: '  024 1  ', email: '' }, actor.userId);
    expect(view).toMatchObject({ ...COMPANY, phone: '024 1', email: null, complete: true });
  });
});

describe('templates (FR-D-01)', () => {
  it('refuses issue while no template is active', async () => {
    const contractId = await topicContract();
    await expect(contracts.issue(contractId, actor)).rejects.toMatchObject({
      response: {
        code: 'DOCUMENT_TEMPLATE_MISSING',
        details: { kind: 'contract', pricingModel: 'per_topic' },
      },
    });
  });

  it('installs the interim templates once, active', async () => {
    const made = await templates.installDefaults(actor);
    expect(made.map((item) => `${item.kind}/${item.pricingModel ?? 'all'}`).sort()).toEqual([
      'acceptance/all',
      'amendment/all',
      'contract/package_tier',
      'contract/per_topic',
      'contract/per_unit',
    ]);
    expect(
      made.every((item) => item.isActive && item.version === 1 && item.source === 'default'),
    ).toBe(true);
    expect(made.every((item) => objects.has(item.storageKey))).toBe(true);
    expect(await templates.installDefaults(actor)).toEqual([]);
  });

  it('refuses unknown placeholders and syntax errors, keeps the active version', async () => {
    const bad = buildDocx('x', [p('{contract.number} {partner.cccd}')]);
    await expect(
      templates.upload({ kind: 'contract', pricingModel: 'per_topic' }, upload(bad), actor),
    ).rejects.toMatchObject({
      response: { code: 'DOCUMENT_TEMPLATE_INVALID', details: { unknown: ['partner.cccd'] } },
    });
    const broken = buildDocx('x', [p('{#items}{line_no}')]);
    const check = templates.validate('acceptance', upload(broken));
    expect(check.valid).toBe(false);
    expect(check.errors[0].message).toContain('items');
    await expect(
      templates.upload(
        { kind: 'contract' },
        upload(buildDocx('x', [p('{contract.number}')])),
        actor,
      ),
    ).rejects.toMatchObject({ response: { code: 'DOCUMENT_TEMPLATE_MODEL_REQUIRED' } });
    await expect(
      templates.upload(
        { kind: 'contract', pricingModel: 'per_topic' },
        upload(bad, 'mau.pdf'),
        actor,
      ),
    ).rejects.toMatchObject({ response: { code: 'DOCUMENT_TEMPLATE_INVALID' } });
  });

  it('versions per kind and model, one active at a time', async () => {
    const file = buildDocx('x', [p('HĐ {contract.number} – {partner.full_name} – {company.name}')]);
    const v2 = await templates.upload(
      { kind: 'contract', pricingModel: 'per_topic', name: 'Bản ngắn', activate: true },
      upload(file),
      actor,
    );
    expect(v2).toMatchObject({ version: 2, isActive: true, name: 'Bản ngắn' });
    expect(v2.warnings).toEqual(['company.representative', 'partner.id_number']);
    expect(v2.placeholders).toEqual(['contract.number', 'partner.full_name', 'company.name']);
    const listed = await templates.list({ kind: 'contract', pricingModel: 'per_topic' });
    expect(listed.map((item) => [item.version, item.isActive])).toEqual([
      [2, true],
      [1, false],
    ]);
    await templates.activate(listed[1].id, actor);
    expect((await templates.active('contract', 'per_topic'))?.version).toBe(1);
    const acceptance = await templates.active('acceptance', 'per_unit');
    expect(acceptance).toMatchObject({ kind: 'acceptance', pricingModel: null });
  });
});

describe('contract issue → worker render', () => {
  it('lists placeholders left empty instead of issuing (FR-D-03)', async () => {
    const contractId = await topicContract();
    profile = accountProfile({ tax_number: null, id_issued_place: '  ' });
    await expect(contracts.issue(contractId, actor)).rejects.toMatchObject({
      response: {
        code: 'DOCUMENT_DATA_MISSING',
        details: { missing: ['partner.id_issued_place', 'partner.tax_code'] },
      },
    });
    expect(queue.addJob).not.toHaveBeenCalled();
  });

  it('issues with the party A snapshot, renders DOCX and PDF from the snapshots', async () => {
    const contractId = await topicContract();
    const issued = await contracts.issue(contractId, actor);
    expect(issued.status).toBe('issued');
    expect(issued.companySnapshot).toMatchObject(COMPANY);
    const active = await templates.active('contract', 'per_topic');
    expect(issued.templateVersionId).toBe(active!.id);

    const [document] = await generatedOf(contractId);
    expect(document).toMatchObject({ status: 'pending', version: 1, templateId: active!.id });
    expect(queue.addJob).toHaveBeenCalledWith({ documentId: document.id }, 0);

    // Party A changes after issue: the document keeps the snapshot (FR-D-05).
    await company.update({ representative: 'Bà Trần Thị B' }, actor.userId);
    await documents.generate(document.id);
    const [ready] = await generatedOf(contractId);
    expect(ready).toMatchObject({ status: 'ready', pdfStatus: 'ready', attempts: 1 });
    expect(ready.checksumSha256).toHaveLength(64);
    expect(ready.fileName).toMatch(/^HD-.+-HDSXND-AG-T-v1\.docx$/);
    const text = await contentText(ready);
    expect(text).toContain(issued.contractNumber);
    expect(text).toContain('Nguyễn Hữu Hoàng');
    expect(text).toContain('035086000030');
    expect(text).toContain('Ông Nguyễn Văn A');
    expect(text).not.toContain('Bà Trần Thị B');
    expect(text).toContain('Đơn giá: 2.500.000 đồng/chủ đề');
    expect(text).not.toMatch(/[{}]/);
    const pdf = await documents.content(ready, 'pdf', actor);
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.fileName).toMatch(/\.pdf$/);
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_VIEWED', category: 'contract_document' }),
    );
    // Nothing personal in the audit metadata.
    expect(JSON.stringify(systemLog.write.mock.calls)).not.toContain('035086000030');
    await company.update({ representative: COMPANY.representative }, actor.userId);

    const listed = await documents.listForContract(contractId);
    expect(listed[0]).toMatchObject({
      ownerLabel: 'Hợp đồng',
      formats: ['docx', 'pdf'],
      templateVersion: 1,
    });
    expect(listed[0]).not.toHaveProperty('storageKey');
    expect((await documents.findVersion('contract', contractId, 1)).id).toBe(ready.id);

    // Re-issue after unissue: a new version.
    await contracts.unissue(contractId, actor);
    await contracts.issue(contractId, actor);
    expect((await generatedOf(contractId)).map((row) => row.version)).toEqual([1, 2]);
  });

  it('keeps the DOCX when Gotenberg fails or is off, then remakes the PDF', async () => {
    const contractId = await topicContract();
    await contracts.issue(contractId, actor);
    const [document] = await generatedOf(contractId);
    gotenberg.convertDocx.mockRejectedValueOnce(new PdfConversionError('Gotenberg trả lỗi 503'));
    await documents.generate(document.id);
    let [row] = await generatedOf(contractId);
    expect(row).toMatchObject({
      status: 'ready',
      pdfStatus: 'failed',
      pdfError: 'Gotenberg trả lỗi 503',
    });
    await expect(documents.content(row, 'pdf', actor)).rejects.toMatchObject({
      response: { code: 'DOCUMENT_PDF_NOT_READY' },
    });
    const regenerated = await documents.regenerate(row, actor);
    expect(regenerated.pdfStatus).toBe('pending');
    expect(queue.addJob).toHaveBeenLastCalledWith({ documentId: row.id }, 2);
    await documents.generate(row.id);
    [row] = await generatedOf(contractId);
    expect(row.pdfStatus).toBe('ready');

    gotenbergOn = false;
    const other = await topicContract();
    await contracts.issue(other, actor);
    const [docxOnly] = await generatedOf(other);
    await documents.generate(docxOnly.id);
    expect((await generatedOf(other))[0]).toMatchObject({ status: 'ready', pdfStatus: 'skipped' });
  });

  it('marks a failed render and retries it', async () => {
    const contractId = await topicContract();
    await contracts.issue(contractId, actor);
    const [document] = await generatedOf(contractId);
    const template = await ds
      .getRepository(DocumentTemplateEntity)
      .findOneByOrFail({ id: document.templateId! });
    const saved = objects.get(template.storageKey)!;
    objects.delete(template.storageKey);
    await expect(documents.generate(document.id)).rejects.toThrow('NoSuchKey');
    let [row] = await generatedOf(contractId);
    expect(row).toMatchObject({ status: 'failed' });
    await expect(documents.content(row, 'docx', actor)).rejects.toMatchObject({
      response: { code: 'DOCUMENT_NOT_READY' },
    });
    objects.set(template.storageKey, saved);
    await documents.regenerate(row, actor);
    await documents.generate(row.id);
    [row] = await generatedOf(contractId);
    expect(row).toMatchObject({ status: 'ready', attempts: 2, error: null });
  });

  it('stores signed copies and accepts only those to activate', async () => {
    const draft = await topicContract();
    const scan = { originalname: 'ban-ky.pdf', size: 8, buffer: Buffer.from('%PDF-1.4') };
    await expect(documents.uploadSigned('contract', draft, scan, actor)).rejects.toMatchObject({
      response: { code: 'DOCUMENT_SIGNED_FILE_NOT_ALLOWED' },
    });
    await contracts.issue(draft, actor);
    await expect(
      documents.uploadSigned('contract', draft, { ...scan, originalname: 'x.exe' }, actor),
    ).rejects.toMatchObject({ response: { code: 'DOCUMENT_SIGNED_FILE_INVALID' } });
    const signed = await documents.uploadSigned('contract', draft, scan, actor);
    expect(signed).toMatchObject({
      kind: 'signed',
      version: 1,
      status: 'ready',
      contentType: 'application/pdf',
      formats: ['pdf'],
    });
    const [row] = (await ds.query(
      `SELECT signed_file_id AS "signedFileId" FROM contracts WHERE id = $1`,
      [draft],
    )) as Array<{ signedFileId: string }>;
    expect(row.signedFileId).toBe(signed.id);
    const signedRow = await documents.find(signed.id);
    expect((await documents.content(signedRow, 'docx', actor)).buffer.toString()).toBe('%PDF-1.4');
    await expect(documents.regenerate(signedRow, actor)).rejects.toMatchObject({
      response: { code: 'DOCUMENT_NOT_REGENERABLE' },
    });

    await expect(
      contracts.activate(draft, { signedDate: '2026-11-03', signedFileId: randomUUID() }, actor),
    ).rejects.toMatchObject({ response: { code: 'DOCUMENT_SIGNED_FILE_INVALID' } });
    const active = await contracts.activate(draft, { signedDate: '2026-11-03' }, actor);
    expect(active).toMatchObject({ status: 'active', signedFileId: signed.id });
  });

  it('issues an amendment with its own snapshots and renders its changes', async () => {
    const contractId = await topicContract('active');
    // The template prints the signing date: without it the amendment is refused (FR-D-03).
    const draft = await contracts.createAmendment(
      contractId,
      { effectiveDate: '2026-12-01', changes: { capAmount: 120_000_000 } },
      actor,
    );
    await expect(contracts.issueAmendment(contractId, draft.id, actor)).rejects.toMatchObject({
      response: {
        code: 'DOCUMENT_DATA_MISSING',
        details: { missing: ['contract.signed_date_text'] },
      },
    });
    await contracts.removeAmendment(contractId, draft.id, actor);
    await ds.query(`UPDATE contracts SET signed_date = '2026-08-01' WHERE id = $1`, [contractId]);
    const amendment = await contracts.createAmendment(
      contractId,
      { effectiveDate: '2026-12-01', changes: { capAmount: 150_000_000 }, reason: 'Tăng trần' },
      actor,
    );
    const issued = await contracts.issueAmendment(contractId, amendment.id, actor);
    expect(issued).toMatchObject({
      status: 'issued',
      companySnapshot: expect.objectContaining(COMPANY),
    });
    const [document] = await generatedOf(amendment.id);
    await documents.generate(document.id);
    const [ready] = await generatedOf(amendment.id);
    const text = await contentText(ready);
    expect(text).toContain('PHỤ LỤC SỬA ĐỔI HỢP ĐỒNG SỐ 1');
    expect(text).toContain('150.000.000 đồng (Một trăm năm mươi triệu đồng)');
    expect(text).toContain('Tăng trần');
    expect(text).toContain('Nguyễn Hữu Hoàng');
    const listed = await documents.listForContract(contractId);
    expect(listed[0].ownerLabel).toBe('Phụ lục sửa đổi số 1');
  });
});

describe('acceptance records', () => {
  async function record(contractId: string, status: string, appendixNumber: number | null) {
    const id = randomUUID();
    const snapshot =
      status === 'draft'
        ? null
        : cipher.encryptJson(
            buildPartnerSnapshot(
              { accountUserId: 'acc-1', code: 'NHH' },
              accountProfile(),
              new Date(),
            ),
          );
    await ds.query(
      `INSERT INTO acceptance_records (id, contract_id, partner_id, pricing_model, appendix_number,
         period_start, period_end, record_date, status, gross_amount, tax_rate, tax_amount, net_payable,
         net_payable_words, terms_snapshot, partner_snapshot_enc, partner_snapshot_at, company_snapshot,
         prepared_by)
       VALUES ($1, $2, $3, 'per_topic', $4, '2026-09-01', '2026-09-30', $5, $6, 72500000, 10, 7250000,
         65250000, 'Sáu mươi lăm triệu hai trăm năm mươi nghìn đồng', $7, $8, $9, $10, 'test')`,
      [
        id,
        contractId,
        partnerId,
        appendixNumber,
        status === 'draft' ? null : '2026-10-07',
        status,
        JSON.stringify({
          pricing_model: 'per_topic',
          pricing_config: { unit_price: 2_500_000, min_topic_minutes: 20 },
          tech_spec: { min_width: 3840, min_height: 2160, min_shots_per_scene: 5 },
          payment_term_business_days: 30,
        }),
        snapshot,
        snapshot ? new Date() : null,
        status === 'draft' ? null : JSON.stringify(COMPANY),
      ],
    );
    await ds.query(
      `INSERT INTO acceptance_items (id, acceptance_id, line_no, line_key, product_label, unit,
         computed_quantity, quantity, computed_unit_price, unit_price, computed_amount, amount, metrics)
       VALUES ($1, $2, 1, 'topic:x', 'VIDEO TRẢI NGHIỆM', 'topic', 29, 29, 2500000, 2500000,
         72500000, 72500000, '{}')`,
      [randomUUID(), id],
    );
    return id;
  }

  it('checks and renders an issued record like D2', async () => {
    const contractId = await topicContract('active');
    await ds.query(
      `UPDATE contracts SET signed_date = '2026-08-01', last_appendix_number = 1 WHERE id = $1`,
      [contractId],
    );
    const id = await record(contractId, 'issued', 2);
    const prepared = await documents.prepareIssue('acceptance', id);
    expect(prepared.companySnapshot).toMatchObject(COMPANY);
    const document = await documents.requestGeneration({
      ownerType: 'acceptance',
      ownerId: id,
      templateId: prepared.templateId,
      actor,
    });
    await documents.generate(document.id);
    const ready = await documents.findVersion('acceptance', id, 1);
    expect(ready.fileName).toMatch(/^BBNT-PL2-/);
    const text = await contentText(ready);
    for (const expected of [
      'PHỤ LỤC HỢP ĐỒNG SỐ 2',
      'Số chủ đề',
      'VIDEO TRẢI NGHIỆM',
      '29 chủ đề',
      '2.500.000',
      '72.500.000',
      '7.250.000',
      '65.250.000',
      'Sáu mươi lăm triệu hai trăm năm mươi nghìn đồng',
      'ngày 07 tháng 10 năm 2026',
      'ký ngày 01 tháng 08 năm 2026',
      'trong vòng 30 ngày làm việc',
      'Mỗi bối cảnh có tối thiểu 5 shot',
    ]) {
      expect(text).toContain(expected);
    }
    const listed = await documents.listForOwner('acceptance', id);
    expect(listed[0].ownerLabel).toBe('BBNT – Phụ lục số 2');
  });

  it('previews a draft with the partner and party A given, without storing anything', async () => {
    const contractId = await topicContract('active');
    await ds.query(
      `UPDATE contracts SET signed_date = '2026-08-01', last_appendix_number = 3 WHERE id = $1`,
      [contractId],
    );
    const id = await record(contractId, 'draft', null);
    const before = objects.size;
    const partner = buildPartnerSnapshot(
      { accountUserId: 'acc-1', code: 'NHH' },
      accountProfile(),
      new Date(),
    );
    const preview = await documents.preview('acceptance', id, {
      format: 'docx',
      partner,
      company: await company.current(),
      actor,
    });
    expect(preview.missing).toEqual([]);
    expect(preview.fileName).toMatch(/xem-truoc\.docx$/);
    const text = docxText(preview.buffer);
    expect(text).toContain('PHỤ LỤC HỢP ĐỒNG SỐ 4');
    expect(text).toContain('Nguyễn Hữu Hoàng');
    expect(objects.size).toBe(before);
    expect(await generatedOf(id)).toEqual([]);
    expect(systemLog.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_PREVIEWED' }),
    );

    const empty = await documents.preview('acceptance', id, {
      format: 'docx',
      partner: null,
      company: null,
      actor,
    });
    expect(empty.missing).toEqual(
      expect.arrayContaining(['company.name', 'partner.full_name', 'partner.tax_code']),
    );

    const pdf = await documents.preview('acceptance', id, { format: 'pdf', partner, actor });
    expect(pdf.contentType).toBe('application/pdf');
    gotenbergOn = false;
    await expect(
      documents.preview('acceptance', id, { format: 'pdf', partner, actor }),
    ).rejects.toMatchObject({ response: { code: 'DOCUMENT_PDF_DISABLED' } });
  });
});
