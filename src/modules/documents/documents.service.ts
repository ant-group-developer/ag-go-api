import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import type { AcceptanceUnit, DeliveryMethod } from '../../database/entities/acceptance.entity';
import type { PricingModel } from '../../database/entities/contract.entity';
import { DocumentTemplateEntity } from '../../database/entities/document-template.entity';
import {
  GeneratedDocumentEntity,
  type DocumentOwnerType,
} from '../../database/entities/generated-document.entity';
import { DocumentQueueService } from '../../infra/queue/document-queue.service';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { SystemLogService } from '../logs/system-log.service';
import type { PartnerActor } from '../partners/partner-actor';
import { selectRateCardVersion, type RateCardStatus } from '../pricing-engine/rate-card';
import { CompanySettingsService } from './company-settings.service';
import { vietnamDay } from './document-format';
import { missingValues } from './document-placeholders';
import { DOCUMENT_AUDIT_CATEGORY, DocumentTemplatesService } from './document-templates.service';
import { DOCX_CONTENT_TYPE, parseTemplate, PDF_CONTENT_TYPE, renderDocx } from './docx-renderer';
import type { DocumentFormat } from './dto/document.dto';
import { GotenbergClient, PdfConversionError } from './gotenberg.client';
import {
  buildRenderData,
  type CompanySnapshot,
  type ContractFacts,
  type PartnerSnapshotData,
  type RateCardFacts,
  type RenderInput,
} from './render-data';
import { readObjectBuffer } from './storage-buffer';

export const DOCUMENT_ERROR_CODES = {
  NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  TEMPLATE_MISSING: 'DOCUMENT_TEMPLATE_MISSING',
  DATA_MISSING: 'DOCUMENT_DATA_MISSING',
  NOT_READY: 'DOCUMENT_NOT_READY',
  PDF_NOT_READY: 'DOCUMENT_PDF_NOT_READY',
  PDF_DISABLED: 'DOCUMENT_PDF_DISABLED',
  PDF_FAILED: 'DOCUMENT_PDF_FAILED',
  SIGNED_FILE_REQUIRED: 'DOCUMENT_SIGNED_FILE_REQUIRED',
  SIGNED_FILE_INVALID: 'DOCUMENT_SIGNED_FILE_INVALID',
  SIGNED_FILE_NOT_ALLOWED: 'DOCUMENT_SIGNED_FILE_NOT_ALLOWED',
  NOT_REGENERABLE: 'DOCUMENT_NOT_REGENERABLE',
} as const;

/** Largest signed copy accepted (scan / PDF). */
export const MAX_SIGNED_FILE_BYTES = 20 * 1024 * 1024;

const SIGNED_FILE_TYPES: Record<string, string> = {
  pdf: PDF_CONTENT_TYPE,
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  docx: DOCX_CONTENT_TYPE,
};

/** Owner statuses that have a document to sign. */
const SIGNABLE_STATUSES: Record<DocumentOwnerType, readonly string[]> = {
  contract: ['issued', 'active', 'suspended', 'completed', 'terminated'],
  amendment: ['issued', 'signed'],
  acceptance: ['issued', 'signed', 'partially_paid', 'paid'],
};

export type UploadedFile = {
  originalname: string;
  mimetype?: string;
  size: number;
  buffer: Buffer;
};

export type PreparedIssue = { companySnapshot: CompanySnapshot; templateId: string };

export type DocumentResponse = Omit<GeneratedDocumentEntity, 'storageKey' | 'pdfStorageKey'> & {
  /** `Hợp đồng`, `Phụ lục sửa đổi số 1`, `BBNT – Phụ lục số 2`. */
  ownerLabel: string;
  templateVersion: number | null;
  /** Formats that can be read now. */
  formats: DocumentFormat[];
};

export type DocumentContent = {
  buffer: Buffer;
  contentType: string;
  fileName: string;
};

type OwnerRow = {
  ownerType: DocumentOwnerType;
  ownerId: string;
  contractId: string;
  status: string;
  pricingModel: PricingModel;
  contractNumber: string;
  number: number | null;
};

type ContractRow = ContractFacts & {
  id: string;
  status: string;
  lastAppendixNumber: number;
  partnerSnapshotEnc: string | null;
  companySnapshot: CompanySnapshot | null;
};

type LoadOptions = {
  draft: boolean;
  documentDate: string;
  /** Undefined: the owner's stored snapshot; null: none. */
  partner?: PartnerSnapshotData | null;
  company?: CompanySnapshot | null;
  /** Draft acceptance record: print the appendix number it would get. */
  predictAppendix?: boolean;
};

const n = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** `070926/HĐSXND/AG-NVB` → `070926-HDSXND-AG-NVB` (file names stay ASCII). */
export function fileSlug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Documents of contracts, amendments and acceptance records (spec 6.5, 13): the check before issue
 * (party A, active template, no placeholder left empty: FR-D-03), the render on worker-io from the
 * snapshots stored at issue (DOCX to R2, PDF through Gotenberg when configured, Q4), previews of
 * drafts rendered on the server and never stored, signed copies (FR-D-04) and reading files back
 * through the API (no R2 URL reaches the browser).
 *
 * Visibility of the owner is checked by the callers (contracts / acceptances services).
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(GeneratedDocumentEntity)
    private readonly documents: Repository<GeneratedDocumentEntity>,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    private readonly templates: DocumentTemplatesService,
    private readonly company: CompanySettingsService,
    private readonly cipher: PiiCipherService,
    private readonly gotenberg: GotenbergClient,
    private readonly queue: DocumentQueueService,
    private readonly systemLog: SystemLogService,
  ) {}

  // -------------------------------------------------------------------------
  // Issue
  // -------------------------------------------------------------------------

  /**
   * Before an owner is issued: party A complete (422 COMPANY_PROFILE_INCOMPLETE), an active template
   * (422 DOCUMENT_TEMPLATE_MISSING) and every placeholder it uses filled (422 DOCUMENT_DATA_MISSING,
   * `details.missing`). `partner`: the snapshot about to be stored (undefined: the stored one).
   * `templateId`: a version chosen on the draft (contract `template_version_id`), else the active one.
   */
  async prepareIssue(
    ownerType: DocumentOwnerType,
    ownerId: string,
    partner?: PartnerSnapshotData,
    templateId?: string | null,
  ): Promise<PreparedIssue> {
    const company = await this.company.snapshot();
    const input = await this.loadInput(ownerType, ownerId, {
      draft: false,
      documentDate: vietnamDay(new Date()),
      partner,
      company,
      predictAppendix: true,
    });
    const template = await this.issueTemplate(ownerType, input.contract.pricingModel, templateId);
    const parsed = parseTemplate(await this.templates.buffer(template));
    if (!parsed.ok) {
      throw new UnprocessableEntityException({
        code: DOCUMENT_ERROR_CODES.TEMPLATE_MISSING,
        message: 'The active template cannot be read; upload a new version',
        details: { templateId: template.id, errors: parsed.errors },
      });
    }
    const missing = missingValues(parsed.tags, buildRenderData(input));
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        code: DOCUMENT_ERROR_CODES.DATA_MISSING,
        message: 'Some placeholders of the template have no value',
        details: { missing, templateId: template.id },
      });
    }
    return { companySnapshot: company, templateId: template.id };
  }

  /**
   * After issue: a new `generated` version (pending) and its job on worker-io. A queue failure
   * leaves it pending (regenerate later), it never undoes the issue.
   */
  async requestGeneration(input: {
    ownerType: DocumentOwnerType;
    ownerId: string;
    templateId: string;
    actor: PartnerActor;
  }): Promise<GeneratedDocumentEntity> {
    const owner = await this.owner(this.dataSource.manager, input.ownerType, input.ownerId);
    const document = await this.insertVersion(owner, 'generated', input.actor, (version) => ({
      templateId: input.templateId,
      status: 'pending',
      fileName: `${this.baseName(owner)}-v${version}.docx`,
      contentType: DOCX_CONTENT_TYPE,
    }));
    await this.enqueue(document, 0);
    await this.audit(input.actor, 'DOCUMENT_GENERATION_REQUESTED', owner, {
      documentId: document.id,
      version: document.version,
      templateId: input.templateId,
    });
    return document;
  }

  /** A signed copy given to activate / sign must be one uploaded for this owner. */
  async assertSignedFile(ownerType: DocumentOwnerType, ownerId: string, fileId: string) {
    const found = await this.documents.count({
      where: { id: fileId, ownerType, ownerId, kind: 'signed' },
    });
    if (found === 0) {
      throw new BadRequestException({
        code: DOCUMENT_ERROR_CODES.SIGNED_FILE_INVALID,
        message: 'signedFileId must be a signed copy uploaded for this document',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  /** Job of worker-io: renders the DOCX from the stored snapshots, then the PDF when configured. */
  async generate(documentId: string): Promise<void> {
    const document = await this.documents.findOne({ where: { id: documentId } });
    if (!document || document.kind !== 'generated') {
      return;
    }
    let docx: Buffer | null = null;
    if (document.status !== 'ready') {
      await this.documents.update(document.id, {
        status: 'processing',
        attempts: document.attempts + 1,
        error: null,
      });
      try {
        const template = await this.dataSource
          .getRepository(DocumentTemplateEntity)
          .findOneByOrFail({ id: document.templateId! });
        const input = await this.loadInput(document.ownerType, document.ownerId, {
          draft: false,
          documentDate: vietnamDay(document.createdAt),
        });
        docx = renderDocx(await this.templates.buffer(template), buildRenderData(input));
        const key = `${this.prefix(document)}/v${document.version}.docx`;
        await this.storage.putObject(key, docx, DOCX_CONTENT_TYPE, docx.length);
        Object.assign(document, {
          status: 'ready',
          storageKey: key,
          sizeBytes: docx.length,
          checksumSha256: sha256(docx),
          generatedAt: new Date(),
          error: null,
        });
        await this.documents.update(document.id, {
          status: 'ready',
          storageKey: key,
          sizeBytes: docx.length,
          checksumSha256: document.checksumSha256,
          generatedAt: document.generatedAt,
          error: null,
        });
        await this.systemLog.write({
          level: 'info',
          category: DOCUMENT_AUDIT_CATEGORY,
          action: 'DOCUMENT_GENERATED',
          message: `DOCUMENT_GENERATED ${document.ownerType} ${document.ownerId} v${document.version}`,
          userId: document.createdBy,
          metadata: this.documentMetadata(document),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.documents.update(document.id, {
          status: 'failed',
          error: message.slice(0, 1000),
        });
        throw error;
      }
    }
    if (document.pdfStatus !== 'ready') {
      await this.makePdf(document, docx);
    }
  }

  private async makePdf(document: GeneratedDocumentEntity, docx: Buffer | null): Promise<void> {
    if (!this.gotenberg.isConfigured()) {
      await this.documents.update(document.id, { pdfStatus: 'skipped', pdfError: null });
      return;
    }
    try {
      const source = docx ?? (await readObjectBuffer(this.storage, document.storageKey!));
      const pdf = await this.gotenberg.convertDocx(source);
      const key = `${this.prefix(document)}/v${document.version}.pdf`;
      await this.storage.putObject(key, pdf, PDF_CONTENT_TYPE, pdf.length);
      await this.documents.update(document.id, {
        pdfStatus: 'ready',
        pdfStorageKey: key,
        pdfSizeBytes: pdf.length,
        pdfChecksumSha256: sha256(pdf),
        pdfError: null,
      });
    } catch (error) {
      if (!(error instanceof PdfConversionError)) {
        throw error;
      }
      // The DOCX is good: the PDF is retried with "regenerate".
      this.logger.warn(`PDF of document ${document.id} failed: ${error.message}`);
      await this.documents.update(document.id, { pdfStatus: 'failed', pdfError: error.message });
    }
  }

  /**
   * Retries a failed / pending render, or makes the PDF again (Gotenberg was down or configured
   * since). 409 for a signed copy.
   */
  async regenerate(document: GeneratedDocumentEntity, actor: PartnerActor) {
    if (document.kind !== 'generated') {
      throw new ConflictException({
        code: DOCUMENT_ERROR_CODES.NOT_REGENERABLE,
        message: 'A signed copy cannot be regenerated',
      });
    }
    const changes: Partial<GeneratedDocumentEntity> =
      document.status === 'ready'
        ? { pdfStatus: 'pending', pdfError: null }
        : { status: 'pending', error: null, pdfStatus: 'none' };
    await this.documents.update(document.id, changes);
    const updated = { ...document, ...changes } as GeneratedDocumentEntity;
    await this.enqueue(updated, document.attempts + 1);
    const owner = await this.owner(this.dataSource.manager, document.ownerType, document.ownerId);
    await this.audit(
      actor,
      'DOCUMENT_REGENERATE_REQUESTED',
      owner,
      this.documentMetadata(document),
    );
    return this.toResponse(await this.documents.findOneByOrFail({ id: document.id }));
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async find(id: string): Promise<GeneratedDocumentEntity> {
    const document = await this.documents.findOne({ where: { id } });
    if (!document) {
      throw this.notFound();
    }
    return document;
  }

  async findVersion(ownerType: DocumentOwnerType, ownerId: string, version: number) {
    const document = await this.documents.findOne({
      where: { ownerType, ownerId, kind: 'generated', version },
    });
    if (!document) {
      throw this.notFound();
    }
    return document;
  }

  /** Every document of a contract: its own, its amendments' and its acceptance records'. */
  async listForContract(contractId: string): Promise<DocumentResponse[]> {
    const rows = await this.documents.find({
      where: { contractId },
      order: { createdAt: 'DESC', version: 'DESC' },
    });
    return this.withLabels(rows);
  }

  async listForOwner(ownerType: DocumentOwnerType, ownerId: string): Promise<DocumentResponse[]> {
    const rows = await this.documents.find({
      where: { ownerType, ownerId },
      order: { kind: 'ASC', version: 'DESC' },
    });
    return this.withLabels(rows);
  }

  /**
   * File of a document read back from R2 (inline viewing, spec 13). 409 DOCUMENT_NOT_READY /
   * DOCUMENT_PDF_NOT_READY. Every read is audited: the file holds personal data.
   */
  async content(
    document: GeneratedDocumentEntity,
    format: DocumentFormat,
    actor: PartnerActor,
  ): Promise<DocumentContent> {
    let key: string | null;
    let contentType: string;
    let fileName = document.fileName;
    if (document.kind === 'signed') {
      key = document.storageKey;
      contentType = document.contentType;
    } else if (format === 'pdf') {
      if (document.pdfStatus !== 'ready' || !document.pdfStorageKey) {
        throw new ConflictException({
          code: DOCUMENT_ERROR_CODES.PDF_NOT_READY,
          message: 'The PDF of this document is not available',
          details: { pdfStatus: document.pdfStatus, pdfError: document.pdfError },
        });
      }
      key = document.pdfStorageKey;
      contentType = PDF_CONTENT_TYPE;
      fileName = fileName.replace(/\.docx$/i, '.pdf');
    } else {
      key = document.storageKey;
      contentType = DOCX_CONTENT_TYPE;
    }
    if (document.status !== 'ready' || !key) {
      throw new ConflictException({
        code: DOCUMENT_ERROR_CODES.NOT_READY,
        message: 'The document is not generated yet',
        details: { status: document.status, error: document.error },
      });
    }
    const buffer = await readObjectBuffer(this.storage, key);
    const owner = await this.owner(this.dataSource.manager, document.ownerType, document.ownerId);
    await this.audit(actor, 'DOCUMENT_VIEWED', owner, {
      ...this.documentMetadata(document),
      format: document.kind === 'signed' ? null : format,
    });
    return { buffer, contentType, fileName };
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /**
   * Renders the owner as it is now with its active template, nothing stored (spec 13). `partner`
   * / `company`: values to print for a draft (undefined: the snapshots of an issued owner).
   * `missing`: placeholders printed empty. Audited as a view of personal data.
   */
  async preview(
    ownerType: DocumentOwnerType,
    ownerId: string,
    options: {
      format: DocumentFormat;
      partner?: PartnerSnapshotData | null;
      company?: CompanySnapshot | null;
      actor: PartnerActor;
    },
  ): Promise<DocumentContent & { missing: string[] }> {
    const input = await this.loadInput(ownerType, ownerId, {
      draft: true,
      documentDate: vietnamDay(new Date()),
      partner: options.partner,
      company: options.company,
      predictAppendix: true,
    });
    const owner = await this.owner(this.dataSource.manager, ownerType, ownerId);
    const template = await this.activeTemplate(ownerType, input.contract.pricingModel);
    const source = await this.templates.buffer(template);
    const parsed = parseTemplate(source);
    const data = buildRenderData(input);
    const missing = parsed.ok ? missingValues(parsed.tags, data) : [];
    const docx = renderDocx(source, data);
    const base = `${this.baseName(owner)}-xem-truoc`;
    let result: DocumentContent = {
      buffer: docx,
      contentType: DOCX_CONTENT_TYPE,
      fileName: `${base}.docx`,
    };
    if (options.format === 'pdf') {
      if (!this.gotenberg.isConfigured()) {
        throw new ConflictException({
          code: DOCUMENT_ERROR_CODES.PDF_DISABLED,
          message: 'PDF is not configured (GOTENBERG_URL); preview as DOCX',
        });
      }
      try {
        result = {
          buffer: await this.gotenberg.convertDocx(docx),
          contentType: PDF_CONTENT_TYPE,
          fileName: `${base}.pdf`,
        };
      } catch (error) {
        if (error instanceof PdfConversionError) {
          throw new ServiceUnavailableException({
            code: DOCUMENT_ERROR_CODES.PDF_FAILED,
            message: error.message,
          });
        }
        throw error;
      }
    }
    await this.audit(options.actor, 'DOCUMENT_PREVIEWED', owner, {
      format: options.format,
      templateId: template.id,
      missing,
    });
    return { ...result, missing };
  }

  // -------------------------------------------------------------------------
  // Signed copies
  // -------------------------------------------------------------------------

  /**
   * Stores the signed copy (PDF, JPG, PNG or DOCX, ≤ 20 MB) of an issued owner and links it as the
   * owner's `signed_file_id` (FR-D-04); activate / sign then use it.
   */
  async uploadSigned(
    ownerType: DocumentOwnerType,
    ownerId: string,
    file: UploadedFile | undefined,
    actor: PartnerActor,
  ): Promise<DocumentResponse> {
    if (!file?.buffer || file.size === 0) {
      throw new BadRequestException({
        code: DOCUMENT_ERROR_CODES.SIGNED_FILE_REQUIRED,
        message: 'Upload the signed copy as `file`',
      });
    }
    const extension = /\.([A-Za-z0-9]+)$/.exec(file.originalname)?.[1]?.toLowerCase() ?? '';
    const contentType = SIGNED_FILE_TYPES[extension];
    if (!contentType || file.size > MAX_SIGNED_FILE_BYTES) {
      throw new BadRequestException({
        code: DOCUMENT_ERROR_CODES.SIGNED_FILE_INVALID,
        message: `The signed copy must be PDF, JPG, PNG or DOCX of at most ${MAX_SIGNED_FILE_BYTES / 1024 / 1024} MB`,
      });
    }
    const owner = await this.owner(this.dataSource.manager, ownerType, ownerId);
    if (!SIGNABLE_STATUSES[ownerType].includes(owner.status)) {
      throw new ConflictException({
        code: DOCUMENT_ERROR_CODES.SIGNED_FILE_NOT_ALLOWED,
        message: 'Only an issued document has a signed copy',
        details: { status: owner.status },
      });
    }
    const id = uuidv7();
    const storageKey = `contract-documents/${owner.contractId}/${ownerType}-${ownerId}/signed-${id}.${extension}`;
    await this.storage.putObject(storageKey, file.buffer, contentType, file.size);
    const document = await this.insertVersion(owner, 'signed', actor, (version) => ({
      id,
      status: 'ready',
      fileName: `${this.baseName(owner)}-ban-ky-v${version}.${extension}`,
      contentType,
      storageKey,
      sizeBytes: file.size,
      checksumSha256: sha256(file.buffer),
      generatedAt: new Date(),
    }));
    const table = {
      contract: 'contracts',
      amendment: 'contract_amendments',
      acceptance: 'acceptance_records',
    }[ownerType];
    await this.dataSource.query(
      `UPDATE ${table} SET signed_file_id = $2, updated_at = now() WHERE id = $1`,
      [ownerId, document.id],
    );
    await this.audit(actor, 'DOCUMENT_SIGNED_UPLOADED', owner, this.documentMetadata(document));
    return (await this.withLabels([document]))[0];
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /** Facts of the owner as the builder needs them, from the database and the snapshots. */
  async loadInput(
    ownerType: DocumentOwnerType,
    ownerId: string,
    options: LoadOptions,
  ): Promise<RenderInput> {
    const manager = this.dataSource.manager;
    const owner = await this.owner(manager, ownerType, ownerId);
    const contract = await this.contractRow(manager, owner.contractId);
    let partnerEnc = contract.partnerSnapshotEnc;
    let companySnapshot = contract.companySnapshot;
    let pricingConfig = contract.pricingConfig;
    let techSpec = contract.techSpec;
    let rateCardDate = contract.signedDate ?? contract.startDate;
    let rateCardId: string | null = null;
    const input: Partial<RenderInput> = {};

    if (ownerType === 'amendment') {
      const [row] = (await manager.query(
        `SELECT amendment_number AS "amendmentNumber", effective_date::text AS "effectiveDate",
                reason, changes, partner_snapshot_enc AS "partnerSnapshotEnc",
                company_snapshot AS "companySnapshot"
         FROM contract_amendments WHERE id = $1`,
        [ownerId],
      )) as Array<{
        amendmentNumber: number;
        effectiveDate: string;
        reason: string | null;
        changes: Record<string, unknown>;
        partnerSnapshotEnc: string | null;
        companySnapshot: CompanySnapshot | null;
      }>;
      partnerEnc = row.partnerSnapshotEnc ?? partnerEnc;
      companySnapshot = row.companySnapshot;
      rateCardDate = row.effectiveDate;
      if (row.changes.pricing_config) {
        pricingConfig = row.changes.pricing_config as Record<string, unknown>;
      }
      if (row.changes.tech_spec) {
        techSpec = row.changes.tech_spec as Record<string, unknown>;
      }
      input.amendment = {
        amendmentNumber: Number(row.amendmentNumber),
        effectiveDate: row.effectiveDate,
        reason: row.reason,
        changes: row.changes ?? {},
      };
    }

    if (ownerType === 'acceptance') {
      const [row] = (await manager.query(
        `SELECT appendix_number AS "appendixNumber", record_date::text AS "recordDate",
                period_start::text AS "periodStart", period_end::text AS "periodEnd",
                delivery_method AS "deliveryMethod", delivery_note AS "deliveryNote",
                gross_amount AS "grossAmount", tax_rate::float AS "taxRate", tax_amount AS "taxAmount",
                advance_offset_amount AS "advanceOffsetAmount", net_payable AS "netPayable",
                net_payable_words AS "netPayableWords", terms_snapshot AS "termsSnapshot",
                rate_card_id AS "rateCardId", partner_snapshot_enc AS "partnerSnapshotEnc",
                company_snapshot AS "companySnapshot"
         FROM acceptance_records WHERE id = $1`,
        [ownerId],
      )) as Array<Record<string, unknown>>;
      const items = (await manager.query(
        `SELECT line_no AS "lineNo", product_label AS "productLabel", unit,
                quantity::float AS quantity, unit_price AS "unitPrice", amount, metrics
         FROM acceptance_items WHERE acceptance_id = $1 ORDER BY line_no`,
        [ownerId],
      )) as Array<Record<string, unknown>>;
      const terms = (row.termsSnapshot ?? {}) as Record<string, unknown>;
      partnerEnc = (row.partnerSnapshotEnc as string | null) ?? null;
      companySnapshot = (row.companySnapshot as CompanySnapshot | null) ?? null;
      pricingConfig = (terms.pricing_config as Record<string, unknown>) ?? pricingConfig;
      techSpec = (terms.tech_spec as Record<string, unknown>) ?? techSpec;
      if (terms.payment_term_business_days !== undefined) {
        contract.paymentTermBusinessDays = Number(terms.payment_term_business_days);
      }
      rateCardId = (row.rateCardId as string | null) ?? null;
      rateCardDate = row.periodEnd as string;
      let appendixNumber = n(row.appendixNumber);
      if (appendixNumber === null && options.predictAppendix) {
        appendixNumber = contract.lastAppendixNumber + 1;
      }
      input.acceptance = {
        appendixNumber,
        recordDate:
          (row.recordDate as string | null) ??
          (options.predictAppendix ? options.documentDate : null),
        periodStart: row.periodStart as string,
        periodEnd: row.periodEnd as string,
        deliveryMethod: row.deliveryMethod as DeliveryMethod,
        deliveryNote: (row.deliveryNote as string | null) ?? null,
        grossAmount: Number(row.grossAmount),
        taxRate: Number(row.taxRate),
        taxAmount: Number(row.taxAmount),
        advanceOffsetAmount: Number(row.advanceOffsetAmount),
        netPayable: Number(row.netPayable),
        netPayableWords: (row.netPayableWords as string | null) ?? null,
        items: items.map((item) => ({
          lineNo: Number(item.lineNo),
          productLabel: String(item.productLabel),
          unit: item.unit as AcceptanceUnit,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          amount: Number(item.amount),
          metrics: (item.metrics as Record<string, unknown>) ?? {},
        })),
      };
    }

    const partner =
      options.partner !== undefined
        ? options.partner
        : partnerEnc
          ? this.cipher.decryptJson<PartnerSnapshotData>(partnerEnc)
          : null;
    const company = options.company !== undefined ? options.company : companySnapshot;
    const categoryIds =
      contract.pricingModel === 'package_tier' && Array.isArray(pricingConfig.category_ids)
        ? (pricingConfig.category_ids as string[])
        : [];
    const productNames = categoryIds.length
      ? (
          (await manager.query(
            `SELECT name FROM categories WHERE id = ANY($1::uuid[]) ORDER BY name`,
            [categoryIds],
          )) as Array<{ name: string }>
        ).map((row) => row.name)
      : [];
    const rateCard =
      contract.pricingModel === 'package_tier'
        ? await this.rateCard(manager, pricingConfig, categoryIds, rateCardDate, rateCardId)
        : null;
    return {
      kind: ownerType,
      documentDate: options.documentDate,
      draft: options.draft,
      company,
      partner,
      contract,
      pricingConfig,
      techSpec,
      rateCard,
      productNames,
      amendment: input.amendment ?? null,
      acceptance: input.acceptance ?? null,
    };
  }

  private async contractRow(manager: EntityManager, id: string): Promise<ContractRow> {
    const [row] = (await manager.query(
      `SELECT id, status, contract_number AS "contractNumber", signed_date::text AS "signedDate",
              start_date::text AS "startDate", end_date::text AS "endDate",
              pricing_model AS "pricingModel", pricing_config AS "pricingConfig",
              cap_amount AS "capAmount", advance_amount AS "advanceAmount",
              advance_due_business_days AS "advanceDueBusinessDays",
              acceptance_cycle AS "acceptanceCycle", delivery_rule AS "deliveryRule",
              payment_term_business_days AS "paymentTermBusinessDays", tech_spec AS "techSpec",
              penalty_percent::float AS "penaltyPercent",
              originality_min_percent AS "originalityMinPercent",
              similarity_max_percent AS "similarityMaxPercent",
              non_compete_months AS "nonCompeteMonths",
              last_appendix_number AS "lastAppendixNumber",
              partner_snapshot_enc AS "partnerSnapshotEnc", company_snapshot AS "companySnapshot"
       FROM contracts WHERE id = $1`,
      [id],
    )) as Array<Record<string, unknown>>;
    if (!row) {
      throw this.notFound();
    }
    return {
      id: row.id as string,
      status: row.status as string,
      contractNumber: row.contractNumber as string,
      signedDate: (row.signedDate as string | null) ?? null,
      startDate: row.startDate as string,
      endDate: (row.endDate as string | null) ?? null,
      pricingModel: row.pricingModel as PricingModel,
      pricingConfig: (row.pricingConfig as Record<string, unknown>) ?? {},
      capAmount: n(row.capAmount),
      advanceAmount: Number(row.advanceAmount ?? 0),
      advanceDueBusinessDays: n(row.advanceDueBusinessDays),
      acceptanceCycle: row.acceptanceCycle as string,
      deliveryRule: (row.deliveryRule as Record<string, unknown> | null) ?? null,
      paymentTermBusinessDays: Number(row.paymentTermBusinessDays),
      techSpec: (row.techSpec as Record<string, unknown>) ?? {},
      penaltyPercent: Number(row.penaltyPercent),
      originalityMinPercent: n(row.originalityMinPercent),
      similarityMaxPercent: n(row.similarityMaxPercent),
      nonCompeteMonths: n(row.nonCompeteMonths),
      lastAppendixNumber: Number(row.lastAppendixNumber ?? 0),
      partnerSnapshotEnc: (row.partnerSnapshotEnc as string | null) ?? null,
      companySnapshot: (row.companySnapshot as CompanySnapshot | null) ?? null,
    };
  }

  /**
   * Rate card printed on a `package_tier` document: the version priced on the record
   * (`rateCardId`), else the version of the code in force on `date` (Q-R1).
   */
  private async rateCard(
    manager: EntityManager,
    config: Record<string, unknown>,
    categoryIds: string[],
    date: string,
    rateCardId: string | null,
  ): Promise<RateCardFacts | null> {
    let card: { id: string; code: string; version: number; effectiveFrom: string } | null = null;
    if (rateCardId) {
      const [row] = (await manager.query(
        `SELECT id, code, version, effective_from::text AS "effectiveFrom" FROM rate_cards WHERE id = $1`,
        [rateCardId],
      )) as Array<{ id: string; code: string; version: number; effectiveFrom: string }>;
      card = row ?? null;
    } else if (typeof config.rate_card_id === 'string') {
      const versions = (await manager.query(
        `SELECT id, code, version, status, effective_from::text AS "effectiveFrom",
                effective_to::text AS "effectiveTo"
         FROM rate_cards WHERE code = $1 AND status = 'published'`,
        [config.rate_card_id],
      )) as Array<{
        id: string;
        code: string;
        version: number;
        status: RateCardStatus;
        effectiveFrom: string;
        effectiveTo: string | null;
      }>;
      card = selectRateCardVersion(versions, date);
    }
    if (!card) {
      return null;
    }
    const level = typeof config.level === 'string' ? config.level : 'LV1';
    const prices = (await manager.query(
      `SELECT category.name AS product, item.pricing_type AS "pricingType", item.tier,
              item.source_min AS "sourceMin", item.source_max AS "sourceMax",
              item.scene_min AS "sceneMin", item.price, item.min_source_seconds AS "minSourceSeconds"
       FROM rate_card_items item
       INNER JOIN categories category ON category.id = item.category_id
       WHERE item.rate_card_id = $1 AND item.category_id = ANY($2::uuid[])
         AND item.level IN ($3, 'ALL')
       ORDER BY category.name, item.pricing_type, item.tier NULLS LAST`,
      [card.id, categoryIds, level],
    )) as Array<Record<string, unknown>>;
    const [rule] = (await manager.query(
      `SELECT extra_scene_price AS "extraScenePrice", extra_scene_min_sources AS "extraSceneMinSources"
       FROM rate_card_level_rules WHERE rate_card_id = $1 AND level = $2`,
      [card.id, level],
    )) as Array<{ extraScenePrice: string; extraSceneMinSources: number }>;
    return {
      code: card.code,
      version: Number(card.version),
      effectiveFrom: card.effectiveFrom,
      prices: prices.map((price) => ({
        product: String(price.product),
        pricingType: price.pricingType as 'tier' | 'per_source',
        tier: n(price.tier),
        sourceMin: n(price.sourceMin),
        sourceMax: n(price.sourceMax),
        sceneMin: n(price.sceneMin),
        price: Number(price.price),
        minSourceSeconds: n(price.minSourceSeconds),
      })),
      extraScenePrice: rule ? Number(rule.extraScenePrice) : null,
      extraSceneMinSources: rule ? Number(rule.extraSceneMinSources) : null,
    };
  }

  /** Contract, status, model and number of an owner (404 when it does not exist). */
  private async owner(
    manager: EntityManager,
    ownerType: DocumentOwnerType,
    ownerId: string,
  ): Promise<OwnerRow> {
    const queries: Record<DocumentOwnerType, string> = {
      contract: `SELECT contract.id AS "contractId", contract.status, contract.pricing_model AS "pricingModel",
                        contract.contract_number AS "contractNumber", NULL::int AS number
                 FROM contracts contract WHERE contract.id = $1`,
      amendment: `SELECT contract.id AS "contractId", amendment.status, contract.pricing_model AS "pricingModel",
                         contract.contract_number AS "contractNumber", amendment.amendment_number AS number
                  FROM contract_amendments amendment
                  INNER JOIN contracts contract ON contract.id = amendment.contract_id
                  WHERE amendment.id = $1`,
      acceptance: `SELECT contract.id AS "contractId", record.status, contract.pricing_model AS "pricingModel",
                          contract.contract_number AS "contractNumber", record.appendix_number AS number
                   FROM acceptance_records record
                   INNER JOIN contracts contract ON contract.id = record.contract_id
                   WHERE record.id = $1`,
    };
    const [row] = (await manager.query(queries[ownerType], [ownerId])) as Array<
      Omit<OwnerRow, 'ownerType' | 'ownerId'>
    >;
    if (!row) {
      throw this.notFound();
    }
    return { ...row, number: n(row.number), ownerType, ownerId };
  }

  /** The chosen version when it fits the owner (kind, pricing model), else the active one. */
  private async issueTemplate(
    ownerType: DocumentOwnerType,
    model: PricingModel,
    templateId: string | null | undefined,
  ) {
    if (templateId) {
      const chosen = await this.dataSource
        .getRepository(DocumentTemplateEntity)
        .findOne({ where: { id: templateId } });
      if (
        !chosen ||
        chosen.kind !== ownerType ||
        (chosen.pricingModel !== null && chosen.pricingModel !== model)
      ) {
        throw new UnprocessableEntityException({
          code: DOCUMENT_ERROR_CODES.TEMPLATE_MISSING,
          message: 'The template chosen for this document does not fit its kind / pricing model',
          details: { templateId, kind: ownerType, pricingModel: model },
        });
      }
      return chosen;
    }
    return this.activeTemplate(ownerType, model);
  }

  private async activeTemplate(ownerType: DocumentOwnerType, model: PricingModel) {
    const template = await this.templates.active(ownerType, model);
    if (!template) {
      throw new UnprocessableEntityException({
        code: DOCUMENT_ERROR_CODES.TEMPLATE_MISSING,
        message: 'No active template for this document (System > contract templates)',
        details: { kind: ownerType, pricingModel: model },
      });
    }
    return template;
  }

  private async insertVersion(
    owner: OwnerRow,
    kind: GeneratedDocumentEntity['kind'],
    actor: PartnerActor,
    fields: (version: number) => Partial<GeneratedDocumentEntity>,
  ): Promise<GeneratedDocumentEntity> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `generated_documents:${owner.ownerType}:${owner.ownerId}:${kind}`,
      ]);
      const [{ last }] = (await manager.query(
        `SELECT COALESCE(MAX(version), 0)::int AS last FROM generated_documents
         WHERE owner_type = $1 AND owner_id = $2 AND kind = $3`,
        [owner.ownerType, owner.ownerId, kind],
      )) as Array<{ last: number }>;
      const version = Number(last) + 1;
      const row = manager.create(GeneratedDocumentEntity, {
        id: uuidv7(),
        contractId: owner.contractId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        kind,
        version,
        templateId: null,
        pdfStatus: 'none',
        attempts: 0,
        createdBy: actor.userId,
        ...fields(version),
      });
      await manager.save(row);
      return row;
    });
  }

  private async enqueue(document: GeneratedDocumentEntity, attempt: number) {
    try {
      await this.queue.addJob({ documentId: document.id }, attempt);
    } catch (error) {
      this.logger.error(
        `Document ${document.id} could not be queued: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async withLabels(rows: GeneratedDocumentEntity[]): Promise<DocumentResponse[]> {
    if (rows.length === 0) {
      return [];
    }
    const templateIds = [...new Set(rows.map((row) => row.templateId).filter(Boolean))] as string[];
    const versions = new Map<string, number>(
      templateIds.length
        ? (
            (await this.dataSource.query(
              `SELECT id, version FROM document_templates WHERE id = ANY($1::uuid[])`,
              [templateIds],
            )) as Array<{ id: string; version: number }>
          ).map((row) => [row.id, Number(row.version)])
        : [],
    );
    const numbers = new Map<string, number | null>();
    for (const ownerType of ['amendment', 'acceptance'] as const) {
      const ids = rows.filter((row) => row.ownerType === ownerType).map((row) => row.ownerId);
      if (ids.length === 0) continue;
      const table = ownerType === 'amendment' ? 'contract_amendments' : 'acceptance_records';
      const column = ownerType === 'amendment' ? 'amendment_number' : 'appendix_number';
      const found = (await this.dataSource.query(
        `SELECT id, ${column} AS number FROM ${table} WHERE id = ANY($1::uuid[])`,
        [ids],
      )) as Array<{ id: string; number: number | null }>;
      for (const row of found) numbers.set(row.id, n(row.number));
    }
    return rows.map((row) =>
      this.toResponse(row, versions.get(row.templateId ?? '') ?? null, numbers.get(row.ownerId)),
    );
  }

  private toResponse(
    row: GeneratedDocumentEntity,
    templateVersion: number | null = null,
    number: number | null | undefined = null,
  ): DocumentResponse {
    const rest: Partial<GeneratedDocumentEntity> = { ...row };
    delete rest.storageKey;
    delete rest.pdfStorageKey;
    const labels: Record<DocumentOwnerType, string> = {
      contract: 'Hợp đồng',
      amendment: `Phụ lục sửa đổi số ${number ?? '?'}`,
      acceptance: number ? `BBNT – Phụ lục số ${number}` : 'BBNT',
    };
    const formats: DocumentFormat[] = [];
    if (row.status === 'ready') {
      formats.push(row.kind === 'signed' && row.contentType === PDF_CONTENT_TYPE ? 'pdf' : 'docx');
      if (row.kind === 'generated' && row.pdfStatus === 'ready') formats.push('pdf');
    }
    return {
      ...(rest as Omit<GeneratedDocumentEntity, 'storageKey' | 'pdfStorageKey'>),
      ownerLabel: labels[row.ownerType],
      templateVersion,
      formats,
    };
  }

  private baseName(owner: OwnerRow): string {
    const contract = fileSlug(owner.contractNumber);
    switch (owner.ownerType) {
      case 'contract':
        return `HD-${contract}`;
      case 'amendment':
        return `PLSD-${owner.number ?? 0}-${contract}`;
      case 'acceptance':
        return `BBNT-PL${owner.number ?? 0}-${contract}`;
    }
  }

  private prefix(document: GeneratedDocumentEntity): string {
    return `contract-documents/${document.contractId}/${document.ownerType}-${document.ownerId}`;
  }

  private documentMetadata(document: GeneratedDocumentEntity) {
    return {
      documentId: document.id,
      kind: document.kind,
      version: document.version,
      contractId: document.contractId,
      ownerType: document.ownerType,
      ownerId: document.ownerId,
    };
  }

  private notFound() {
    return new NotFoundException({
      code: DOCUMENT_ERROR_CODES.NOT_FOUND,
      message: 'Document not found',
    });
  }

  private async audit(
    actor: PartnerActor,
    action: string,
    owner: OwnerRow,
    metadata: Record<string, unknown>,
  ) {
    await this.systemLog.write({
      level: 'info',
      category: DOCUMENT_AUDIT_CATEGORY,
      action,
      message: `${action} ${owner.ownerType} ${owner.ownerId}`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: {
        contractId: owner.contractId,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        ...metadata,
      },
    });
  }
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
