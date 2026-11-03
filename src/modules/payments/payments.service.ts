import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { v7 as uuidv7 } from 'uuid';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import type { ContractStatus } from '../../database/entities/contract.entity';
import { PaymentEntity, type PaymentKind } from '../../database/entities/payment.entity';
import { AcceptancesService } from '../acceptances/acceptances.service';
import { STORAGE_ADAPTER, type StorageAdapter } from '../assets/storage/storage-adapter';
import { ContractsService } from '../contracts/contracts.service';
import type { DocumentContent, UploadedFile } from '../documents/documents.service';
import { PDF_CONTENT_TYPE } from '../documents/docx-renderer';
import { readObjectBuffer } from '../documents/storage-buffer';
import { SystemLogService } from '../logs/system-log.service';
import { hasPermission, type PartnerActor } from '../partners/partner-actor';
import { maskValue } from '../partners/partner-profile';
import { contractDay } from '../project-contracts/project-delivery';
import { loadAdvanceFacts } from './advance-facts';
import type {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  OverdueQueryDto,
  PayoutExportQueryDto,
} from './dto/payment.dto';
import { buildWorkbook, sheet } from './payment-excel';
import {
  advanceBalance,
  buildLedger,
  checkAdvance,
  checkRefund,
  checkSettlement,
  ISSUED_ACCEPTANCE_STATUSES,
  overdueDays,
  PAYABLE_ACCEPTANCE_STATUSES,
  paymentStatus,
  remainingPayable,
  type PaymentCheckError,
} from './payment-ledger';

export const PAYMENT_AUDIT_CATEGORY = 'payment';

export const PAYMENT_ERROR_CODES = {
  NOT_FOUND: 'PAYMENT_NOT_FOUND',
  FORBIDDEN: 'PAYMENT_FORBIDDEN',
  DATE_IN_FUTURE: 'PAYMENT_DATE_IN_FUTURE',
  ACCEPTANCE_REQUIRED: 'PAYMENT_ACCEPTANCE_REQUIRED',
  ACCEPTANCE_NOT_ALLOWED: 'PAYMENT_ACCEPTANCE_NOT_ALLOWED',
  ACCEPTANCE_NOT_FOUND: 'PAYMENT_ACCEPTANCE_NOT_FOUND',
  ACCEPTANCE_NOT_PAYABLE: 'PAYMENT_ACCEPTANCE_NOT_PAYABLE',
  CONTRACT_STATUS: 'PAYMENT_CONTRACT_STATUS',
  EXCEEDS_REMAINING: 'PAYMENT_EXCEEDS_REMAINING',
  ADVANCE_NOT_AGREED: 'PAYMENT_ADVANCE_NOT_AGREED',
  ADVANCE_EXCEEDS_AGREED: 'PAYMENT_ADVANCE_EXCEEDS_AGREED',
  REFUND_EXCEEDS_BALANCE: 'PAYMENT_REFUND_EXCEEDS_BALANCE',
  ADVANCE_ALREADY_OFFSET: 'PAYMENT_ADVANCE_ALREADY_OFFSET',
  ALREADY_CANCELLED: 'PAYMENT_ALREADY_CANCELLED',
  PROOF_REQUIRED: 'PAYMENT_PROOF_REQUIRED',
  PROOF_INVALID: 'PAYMENT_PROOF_INVALID',
  PROOF_MISSING: 'PAYMENT_PROOF_MISSING',
} as const;

/** Contract statuses an advance is paid in, and those a partner returns advance in (FR-C-10). */
const ADVANCE_CONTRACT_STATUSES: readonly ContractStatus[] = ['active', 'suspended'];
const REFUND_CONTRACT_STATUSES: readonly ContractStatus[] = [
  'active',
  'suspended',
  'completed',
  'terminated',
];

/** Largest transfer proof accepted (scan / PDF / screenshot). */
export const MAX_PROOF_FILE_BYTES = 10 * 1024 * 1024;

const PROOF_FILE_TYPES: Record<string, string> = {
  pdf: PDF_CONTENT_TYPE,
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type PaymentView = Omit<PaymentEntity, 'proofStorageKey'> & {
  hasProof: boolean;
  contractNumber: string;
  partnerCode: string;
  partnerName: string;
  appendixNumber: number | null;
};

type PayableRecordRow = {
  id: string;
  contractId: string;
  partnerId: string;
  appendixNumber: number | null;
  periodStart: string;
  periodEnd: string;
  recordDate: string | null;
  status: string;
  grossAmount: number;
  taxAmount: number;
  advanceOffsetAmount: number;
  netPayable: number;
  paid: number;
  dueDate: string | null;
  contractNumber: string;
  partnerCode: string;
  partnerName: string;
  managerUserId: string;
};

const CHECK_MESSAGES: Record<PaymentCheckError['code'], string> = {
  PAYMENT_EXCEEDS_REMAINING: 'The payment is more than what is left to pay on the record',
  PAYMENT_ADVANCE_NOT_AGREED: 'The contract has no advance agreed',
  PAYMENT_ADVANCE_EXCEEDS_AGREED: 'The advances paid would exceed the advance agreed',
  PAYMENT_REFUND_EXCEEDS_BALANCE: 'The refund is more than the advance balance',
};

function today(): string {
  return contractDay(new Date());
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function money(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * Payments of contracts (spec 6.6, 7.8): advances (FR-$-01), payments of signed acceptance records
 * in one or more parts with the record moving to partially_paid / paid (FR-$-02), refunds of the
 * advance (FR-C-10, BR-35), cancellation with a reason instead of deletion, transfer proofs in R2,
 * the contract ledger (FR-$-04), overdue records (FR-$-03) and the payout list for accounting
 * (FR-$-05). Every payment recorded or cancelled is audited.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly contracts: ContractsService,
    private readonly acceptances: AcceptancesService,
    private readonly cipher: PiiCipherService,
    private readonly systemLog: SystemLogService,
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
  ) {}

  async list(query: ListPaymentsQueryDto, actor: PartnerActor) {
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (!this.canSeeAll(actor)) where.push(`contract.manager_user_id = ${param(actor.userId)}`);
    if (query.contractId) where.push(`payment.contract_id = ${param(query.contractId)}`);
    if (query.partnerId) where.push(`payment.partner_id = ${param(query.partnerId)}`);
    if (query.acceptanceId) where.push(`payment.acceptance_id = ${param(query.acceptanceId)}`);
    if (query.kind) where.push(`payment.kind = ${param(query.kind)}`);
    if (query.status) where.push(`payment.status = ${param(query.status)}`);
    if (query.from) where.push(`payment.paid_date >= ${param(query.from)}`);
    if (query.to) where.push(`payment.paid_date <= ${param(query.to)}`);
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const [{ total }] = (await this.dataSource.query(
      `SELECT count(*)::int AS total ${this.paymentFrom()} ${filter}`,
      params,
    )) as Array<{ total: number }>;
    const rows = (await this.dataSource.query(
      `${this.paymentSelect()} ${this.paymentFrom()} ${filter}
       ORDER BY payment.paid_date DESC, payment.created_at DESC, payment.id DESC
       LIMIT ${param(query.pageSize)} OFFSET ${param(query.skip)}`,
      params,
    )) as Array<Record<string, unknown>>;
    return new ListResponseDto(
      rows.map((row) => this.toView(row)),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string, actor: PartnerActor): Promise<PaymentView> {
    const [row] = (await this.dataSource.query(
      `${this.paymentSelect()} ${this.paymentFrom()} WHERE payment.id = $1`,
      [id],
    )) as Array<Record<string, unknown>>;
    if (!row) {
      throw this.notFound();
    }
    await this.assertContractVisible(row.contractId as string, actor);
    return this.toView(row);
  }

  /**
   * Records an advance, the payment of a signed record or a refund. The contract row is locked so
   * the checks (agreed advance, what is left to pay, advance balance) hold under concurrency.
   */
  async create(contractId: string, dto: CreatePaymentDto, actor: PartnerActor) {
    const contract = await this.contracts.findVisible(contractId, actor);
    this.assertManage(actor);
    if (dto.paidDate > today()) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.DATE_IN_FUTURE,
        message: 'paidDate must not be after today',
      });
    }
    if (dto.kind === 'settlement' && !dto.acceptanceId) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.ACCEPTANCE_REQUIRED,
        message: 'A settlement pays one acceptance record: give acceptanceId',
      });
    }
    if (dto.kind !== 'settlement' && dto.acceptanceId) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.ACCEPTANCE_NOT_ALLOWED,
        message: 'Only a settlement is linked to an acceptance record',
      });
    }
    const id = uuidv7();
    const effect = await this.dataSource.transaction(async (manager) => {
      const status = await this.lockContract(manager, contract.id);
      let acceptance: { id: string; from: string; to: string } | null = null;
      let recomputed: string[] = [];
      if (dto.kind === 'settlement') {
        const record = await this.lockPayableRecord(manager, contract.id, dto.acceptanceId!);
        this.assertCheck(checkSettlement(dto.amount, record.netPayable, record.paid));
        acceptance = {
          id: record.id,
          from: record.status,
          to: paymentStatus(record.netPayable, record.paid + dto.amount),
        };
      } else {
        this.assertContractStatus(dto.kind, status);
        const facts = await loadAdvanceFacts(manager, contract.id);
        this.assertCheck(
          dto.kind === 'advance'
            ? checkAdvance(dto.amount, facts.advanceAmount, facts.advancesPaid, facts.refunds)
            : checkRefund(
                dto.amount,
                advanceBalance({ ...facts, offsets: facts.offsetsIssued + facts.offsetsPending }),
              ),
        );
      }
      await manager.insert(PaymentEntity, {
        id,
        contractId: contract.id,
        partnerId: contract.partnerId,
        acceptanceId: dto.kind === 'settlement' ? dto.acceptanceId! : null,
        kind: dto.kind,
        amount: dto.amount,
        paidDate: dto.paidDate,
        method: dto.method ?? 'bank_transfer',
        reference: dto.reference?.trim() || null,
        note: dto.note?.trim() || null,
        status: 'recorded',
        createdBy: actor.userId,
      } as QueryDeepPartialEntity<PaymentEntity>);
      if (acceptance) {
        await this.setRecordStatus(manager, acceptance.id, acceptance.to);
      } else {
        // The advance to offset changed: drafts of the contract are priced again.
        recomputed = await this.acceptances.recomputeDrafts(manager, contract.id);
      }
      return { acceptance, recomputed };
    });
    const view = await this.get(id, actor);
    await this.audit(actor, 'PAYMENT_RECORDED', view, {
      paidDate: view.paidDate,
      method: view.method,
      reference: view.reference,
      acceptanceStatus: effect.acceptance,
      recomputedDrafts: effect.recomputed,
    });
    return view;
  }

  /**
   * Cancels a payment with a reason (never deleted). A settlement takes the record back to
   * partially_paid / signed; an advance already offset on issued records cannot be cancelled.
   */
  async cancel(id: string, reason: string, actor: PartnerActor) {
    this.assertManage(actor);
    const effect = await this.dataSource.transaction(async (manager) => {
      const payment = await this.lockPayment(manager, id, actor);
      if (payment.status === 'cancelled') {
        throw new ConflictException({
          code: PAYMENT_ERROR_CODES.ALREADY_CANCELLED,
          message: 'The payment is already cancelled',
        });
      }
      await this.lockContract(manager, payment.contractId);
      let acceptance: { id: string; from: string; to: string } | null = null;
      let recomputed: string[] = [];
      if (payment.kind === 'advance') {
        const facts = await loadAdvanceFacts(manager, payment.contractId);
        const after = advanceBalance({
          ...facts,
          advancesPaid: facts.advancesPaid - payment.amount,
          offsets: facts.offsetsIssued,
        });
        if (after < 0) {
          throw new ConflictException({
            code: PAYMENT_ERROR_CODES.ADVANCE_ALREADY_OFFSET,
            message:
              'The advance is already offset on issued acceptance records: cancel those first',
            details: { balanceAfter: after },
          });
        }
      }
      if (payment.kind === 'settlement' && payment.acceptanceId) {
        const [record] = (await manager.query(
          `SELECT status, net_payable::bigint AS "netPayable" FROM acceptance_records
           WHERE id = $1 FOR UPDATE`,
          [payment.acceptanceId],
        )) as Array<{ status: string; netPayable: string }>;
        const paid = await this.settled(manager, payment.acceptanceId);
        acceptance = {
          id: payment.acceptanceId,
          from: record.status,
          to: paymentStatus(Number(record.netPayable), paid - payment.amount),
        };
      }
      await manager.update(PaymentEntity, id, {
        status: 'cancelled',
        cancelledReason: reason.trim(),
        cancelledAt: new Date(),
        cancelledBy: actor.userId,
      });
      if (acceptance) {
        await this.setRecordStatus(manager, acceptance.id, acceptance.to);
      } else {
        recomputed = await this.acceptances.recomputeDrafts(manager, payment.contractId);
      }
      return { acceptance, recomputed };
    });
    const view = await this.get(id, actor);
    await this.audit(actor, 'PAYMENT_CANCELLED', view, {
      reason: reason.trim(),
      acceptanceStatus: effect.acceptance,
      recomputedDrafts: effect.recomputed,
    });
    return view;
  }

  /** Stores the transfer proof (PDF, JPG or PNG, ≤ 10 MB) of a payment in R2, replacing any. */
  async uploadProof(id: string, file: UploadedFile | undefined, actor: PartnerActor) {
    this.assertManage(actor);
    if (!file?.buffer || file.size === 0) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.PROOF_REQUIRED,
        message: 'Upload the transfer proof as `file`',
      });
    }
    const extension = /\.([A-Za-z0-9]+)$/.exec(file.originalname)?.[1]?.toLowerCase() ?? '';
    const contentType = PROOF_FILE_TYPES[extension];
    if (!contentType || file.size > MAX_PROOF_FILE_BYTES) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.PROOF_INVALID,
        message: `The proof must be PDF, JPG or PNG of at most ${MAX_PROOF_FILE_BYTES / 1024 / 1024} MB`,
      });
    }
    const payment = await this.get(id, actor);
    if (payment.status === 'cancelled') {
      throw new ConflictException({
        code: PAYMENT_ERROR_CODES.ALREADY_CANCELLED,
        message: 'A cancelled payment takes no proof',
      });
    }
    const storageKey = `contract-documents/${payment.contractId}/payment-${id}/proof-${uuidv7()}.${extension}`;
    await this.storage.putObject(storageKey, file.buffer, contentType, file.size);
    await this.dataSource.manager.update(PaymentEntity, id, {
      proofStorageKey: storageKey,
      proofFileName: `chung-tu-${payment.kind}-${payment.paidDate}.${extension}`,
      proofContentType: contentType,
      proofSizeBytes: file.size,
      proofChecksumSha256: sha256(file.buffer),
      proofUploadedAt: new Date(),
      proofUploadedBy: actor.userId,
    });
    const view = await this.get(id, actor);
    await this.audit(actor, 'PAYMENT_PROOF_UPLOADED', view, {
      sizeBytes: file.size,
      contentType,
      replaced: payment.hasProof,
    });
    return view;
  }

  /** The transfer proof read back from R2 (no R2 URL to the browser); audited. */
  async proofContent(id: string, actor: PartnerActor): Promise<DocumentContent> {
    const payment = await this.get(id, actor);
    const [row] = (await this.dataSource.query(
      `SELECT proof_storage_key AS "key" FROM payments WHERE id = $1`,
      [id],
    )) as Array<{ key: string | null }>;
    if (!row?.key || !payment.proofContentType || !payment.proofFileName) {
      throw new NotFoundException({
        code: PAYMENT_ERROR_CODES.PROOF_MISSING,
        message: 'The payment has no transfer proof',
      });
    }
    const buffer = await readObjectBuffer(this.storage, row.key);
    await this.audit(actor, 'PAYMENT_PROOF_VIEWED', payment, {});
    return { buffer, contentType: payment.proofContentType, fileName: payment.proofFileName };
  }

  /**
   * Ledger of a contract (FR-$-04, spec 10 `GET /contracts/:id/ledger`): accepted value, tax, net,
   * paid, advance and its balance, outstanding, overdue, ceiling usage, refund due when closed;
   * the issued records with what is left on each, and the payments.
   */
  async ledger(contractId: string, actor: PartnerActor) {
    const contract = await this.contracts.findVisible(contractId, actor);
    const manager = this.dataSource.manager;
    const records = await this.issuedRecords(manager, { contractIds: [contract.id] });
    const facts = await loadAdvanceFacts(manager, contract.id);
    const asOf = today();
    const ledger = buildLedger({
      contract,
      records,
      pendingOffsets: facts.offsetsPending,
      advancesPaid: facts.advancesPaid,
      refunds: facts.refunds,
      today: asOf,
    });
    const payments = (await manager.query(
      `${this.paymentSelect()} ${this.paymentFrom()} WHERE payment.contract_id = $1
       ORDER BY payment.paid_date DESC, payment.created_at DESC`,
      [contract.id],
    )) as Array<Record<string, unknown>>;
    return {
      asOf,
      contract: {
        id: contract.id,
        contractNumber: contract.contractNumber,
        status: contract.status,
        partnerId: contract.partnerId,
        managerUserId: contract.managerUserId,
        advanceOffsetRule: contract.advanceOffsetRule,
        paymentTermBusinessDays: contract.paymentTermBusinessDays,
        source: contract.source,
      },
      ...ledger,
      payments: payments.map((row) => this.toView(row)),
    };
  }

  /** Signed records past their payment due date with something left to pay (FR-$-03, FR-R-05). */
  async overdue(query: OverdueQueryDto, actor: PartnerActor) {
    const asOf = query.asOf ?? today();
    const records = await this.issuedRecords(this.dataSource.manager, {
      partnerId: query.partnerId,
      contractIds: query.contractId ? [query.contractId] : undefined,
      managerUserId: this.canSeeAll(actor) ? undefined : actor.userId,
      statuses: [...PAYABLE_ACCEPTANCE_STATUSES],
      dueBefore: asOf,
    });
    const items = records
      .map((record) => {
        const remaining = remainingPayable(record.netPayable, record.paid);
        return { ...record, remaining, overdueDays: overdueDays(record.dueDate, remaining, asOf) };
      })
      .filter((record) => record.overdueDays > 0);
    return {
      asOf,
      count: items.length,
      amount: items.reduce((sum, record) => sum + record.remaining, 0),
      items,
    };
  }

  /**
   * Payout list for accounting (FR-$-05): signed records with something left to pay, the partner's
   * tax number and bank account from the snapshot taken when the record was issued (BR-02). Masked
   * as on screen unless `reveal` with go.partner.pii_read; every export is audited.
   */
  async exportPayouts(query: PayoutExportQueryDto, actor: PartnerActor) {
    this.assertManage(actor);
    const reveal = query.reveal === true;
    if (reveal && !hasPermission(actor, GO_PERMISSIONS.PARTNER_PII_READ)) {
      throw new ForbiddenException({
        code: PAYMENT_ERROR_CODES.FORBIDDEN,
        message: 'Full tax and bank numbers need go.partner.pii_read',
      });
    }
    const asOf = today();
    const records = (
      await this.issuedRecords(this.dataSource.manager, {
        partnerId: query.partnerId,
        contractIds: query.contractId ? [query.contractId] : undefined,
        managerUserId: this.canSeeAll(actor) ? undefined : actor.userId,
        statuses: [...PAYABLE_ACCEPTANCE_STATUSES],
        dueTo: query.dueTo,
      })
    ).filter((record) => remainingPayable(record.netPayable, record.paid) > 0);
    const snapshots = await this.partnerSnapshots(records.map((record) => record.id));
    const rows = records.map((record, index) => {
      const fields = snapshots.get(record.id)?.fields ?? {};
      const remaining = remainingPayable(record.netPayable, record.paid);
      const taxNumber = fields.taxNumber ?? null;
      const account = fields.bankAccountNumber ?? null;
      return {
        no: index + 1,
        partnerCode: record.partnerCode,
        name: snapshots.get(record.id)?.name ?? record.partnerName,
        taxNumber: taxNumber && !reveal ? maskValue(taxNumber, 4, 2) : taxNumber,
        bankAccountNumber: account && !reveal ? `****${account.slice(-4)}` : account,
        bankAccountName: fields.bankAccountName ?? null,
        bank: fields.bankName ?? fields.bankCode ?? null,
        contractNumber: record.contractNumber,
        appendixNumber: record.appendixNumber,
        period: `${record.periodStart} – ${record.periodEnd}`,
        grossAmount: record.grossAmount,
        taxAmount: record.taxAmount,
        advanceOffsetAmount: record.advanceOffsetAmount,
        netPayable: record.netPayable,
        paid: record.paid,
        remaining,
        dueDate: record.dueDate,
        overdueDays: overdueDays(record.dueDate, remaining, asOf),
      };
    });
    const buffer = await buildWorkbook([
      sheet({
        name: 'Danh sách chi trả',
        title: 'DANH SÁCH CHI TRẢ BIÊN BẢN NGHIỆM THU',
        subtitle: [
          `Ngày xuất: ${asOf}${query.dueTo ? ` – hạn thanh toán đến ${query.dueTo}` : ''}`,
        ],
        total: true,
        columns: [
          { header: 'STT', key: 'no', width: 6 },
          { header: 'Mã đối tác', key: 'partnerCode', width: 12 },
          { header: 'Họ tên', key: 'name', width: 26 },
          { header: 'MST', key: 'taxNumber', width: 16 },
          { header: 'Số tài khoản', key: 'bankAccountNumber', width: 20 },
          { header: 'Chủ tài khoản', key: 'bankAccountName', width: 24 },
          { header: 'Ngân hàng', key: 'bank', width: 22 },
          { header: 'Số HĐ', key: 'contractNumber', width: 26 },
          { header: 'Phụ lục số', key: 'appendixNumber', width: 10 },
          { header: 'Kỳ', key: 'period', width: 24 },
          { header: 'Giá trị nghiệm thu', key: 'grossAmount', width: 16, money: true },
          { header: 'Thuế TNCN', key: 'taxAmount', width: 14, money: true },
          { header: 'Đối trừ tạm ứng', key: 'advanceOffsetAmount', width: 16, money: true },
          { header: 'Thực lĩnh', key: 'netPayable', width: 16, money: true },
          { header: 'Đã chi', key: 'paid', width: 16, money: true },
          { header: 'Còn phải trả', key: 'remaining', width: 16, money: true },
          { header: 'Hạn thanh toán', key: 'dueDate', width: 14 },
          { header: 'Quá hạn (ngày)', key: 'overdueDays', width: 12 },
        ],
        rows,
      }),
    ]);
    await this.systemLog.write({
      level: 'info',
      category: PAYMENT_AUDIT_CATEGORY,
      action: 'PAYOUTS_EXPORTED',
      message: `PAYOUTS_EXPORTED ${rows.length} record(s)`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: {
        revealed: reveal,
        count: rows.length,
        acceptanceIds: records.map((record) => record.id),
        filters: { partnerId: query.partnerId, contractId: query.contractId, dueTo: query.dueTo },
      },
    });
    return { buffer, fileName: `danh-sach-chi-tra-${asOf}.xlsx`, contentType: XLSX };
  }

  // -------------------------------------------------------------------------

  /**
   * Acceptance records issued or later (not cancelled) with what was settled on each: the base of
   * the ledger, overdue list, payout export and payables report.
   */
  async issuedRecords(
    manager: EntityManager,
    filter: {
      contractIds?: string[];
      partnerId?: string;
      managerUserId?: string;
      statuses?: string[];
      dueBefore?: string;
      dueTo?: string;
    },
  ): Promise<PayableRecordRow[]> {
    const where = [`record.status = ANY($1::text[])`];
    const params: unknown[] = [filter.statuses ?? [...ISSUED_ACCEPTANCE_STATUSES]];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filter.contractIds)
      where.push(`record.contract_id = ANY(${param(filter.contractIds)}::uuid[])`);
    if (filter.partnerId) where.push(`record.partner_id = ${param(filter.partnerId)}`);
    if (filter.managerUserId)
      where.push(`contract.manager_user_id = ${param(filter.managerUserId)}`);
    if (filter.dueBefore) where.push(`record.due_date < ${param(filter.dueBefore)}`);
    if (filter.dueTo)
      where.push(`(record.due_date IS NULL OR record.due_date <= ${param(filter.dueTo)})`);
    const rows = (await manager.query(
      `SELECT record.id, record.contract_id AS "contractId", record.partner_id AS "partnerId",
              record.appendix_number AS "appendixNumber",
              record.period_start::text AS "periodStart", record.period_end::text AS "periodEnd",
              record.record_date::text AS "recordDate", record.status,
              record.gross_amount::bigint AS "grossAmount", record.tax_amount::bigint AS "taxAmount",
              record.advance_offset_amount::bigint AS "advanceOffsetAmount",
              record.net_payable::bigint AS "netPayable", record.due_date::text AS "dueDate",
              COALESCE(settled.paid, 0)::bigint AS paid,
              contract.contract_number AS "contractNumber",
              contract.manager_user_id AS "managerUserId",
              partner.code AS "partnerCode", partner.display_name AS "partnerName"
       FROM acceptance_records record
       INNER JOIN contracts contract ON contract.id = record.contract_id
       INNER JOIN partners partner ON partner.id = record.partner_id
       LEFT JOIN LATERAL (
         SELECT sum(payment.amount) AS paid FROM payments payment
         WHERE payment.acceptance_id = record.id AND payment.kind = 'settlement'
           AND payment.status = 'recorded'
       ) settled ON true
       WHERE ${where.join(' AND ')}
       ORDER BY record.due_date ASC NULLS LAST, contract.contract_number ASC,
                record.appendix_number ASC`,
      params,
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      ...(row as unknown as PayableRecordRow),
      grossAmount: money(row.grossAmount),
      taxAmount: money(row.taxAmount),
      advanceOffsetAmount: money(row.advanceOffsetAmount),
      netPayable: money(row.netPayable),
      paid: money(row.paid),
    }));
  }

  private async partnerSnapshots(acceptanceIds: string[]) {
    const result = new Map<string, { name?: string; fields: Record<string, string | null> }>();
    if (acceptanceIds.length === 0) {
      return result;
    }
    const rows = (await this.dataSource.query(
      `SELECT id, partner_snapshot_enc AS "enc" FROM acceptance_records
       WHERE id = ANY($1::uuid[]) AND partner_snapshot_enc IS NOT NULL`,
      [acceptanceIds],
    )) as Array<{ id: string; enc: string }>;
    for (const row of rows) {
      try {
        result.set(
          row.id,
          this.cipher.decryptJson<{ name?: string; fields: Record<string, string | null> }>(
            row.enc,
          ),
        );
      } catch {
        // A snapshot that cannot be read (key rotated away) leaves the bank columns empty.
      }
    }
    return result;
  }

  private paymentSelect() {
    return `SELECT payment.id, payment.contract_id AS "contractId", payment.partner_id AS "partnerId",
              payment.acceptance_id AS "acceptanceId", payment.kind,
              payment.amount::bigint AS amount, payment.paid_date::text AS "paidDate",
              payment.method, payment.reference, payment.note, payment.status,
              payment.proof_file_name AS "proofFileName",
              payment.proof_content_type AS "proofContentType",
              payment.proof_size_bytes::bigint AS "proofSizeBytes",
              payment.proof_checksum_sha256 AS "proofChecksumSha256",
              payment.proof_uploaded_at AS "proofUploadedAt",
              payment.proof_uploaded_by AS "proofUploadedBy",
              payment.proof_storage_key IS NOT NULL AS "hasProof",
              payment.cancelled_reason AS "cancelledReason", payment.cancelled_at AS "cancelledAt",
              payment.cancelled_by AS "cancelledBy", payment.created_by AS "createdBy",
              payment.created_at AS "createdAt", payment.updated_at AS "updatedAt",
              contract.contract_number AS "contractNumber",
              partner.code AS "partnerCode", partner.display_name AS "partnerName",
              record.appendix_number AS "appendixNumber"`;
  }

  private paymentFrom() {
    return `FROM payments payment
      INNER JOIN contracts contract ON contract.id = payment.contract_id
      INNER JOIN partners partner ON partner.id = payment.partner_id
      LEFT JOIN acceptance_records record ON record.id = payment.acceptance_id`;
  }

  private toView(row: Record<string, unknown>): PaymentView {
    return {
      ...(row as unknown as PaymentView),
      amount: money(row.amount),
      proofSizeBytes: row.proofSizeBytes === null ? null : money(row.proofSizeBytes),
    };
  }

  private async lockContract(manager: EntityManager, contractId: string) {
    const [row] = (await manager.query(`SELECT status FROM contracts WHERE id = $1 FOR UPDATE`, [
      contractId,
    ])) as Array<{ status: ContractStatus }>;
    return row.status;
  }

  private async lockPayment(manager: EntityManager, id: string, actor: PartnerActor) {
    await manager.query(`SELECT id FROM payments WHERE id = $1 FOR UPDATE`, [id]);
    const payment = await manager.findOne(PaymentEntity, { where: { id } });
    if (!payment) {
      throw this.notFound();
    }
    await this.assertContractVisible(payment.contractId, actor);
    return payment;
  }

  private async lockPayableRecord(manager: EntityManager, contractId: string, id: string) {
    const [record] = (await manager.query(
      `SELECT id, status, net_payable::bigint AS "netPayable" FROM acceptance_records
       WHERE id = $1 AND contract_id = $2 FOR UPDATE`,
      [id, contractId],
    )) as Array<{ id: string; status: string; netPayable: string }>;
    if (!record) {
      throw new NotFoundException({
        code: PAYMENT_ERROR_CODES.ACCEPTANCE_NOT_FOUND,
        message: 'Acceptance record not found in this contract',
      });
    }
    if (!(PAYABLE_ACCEPTANCE_STATUSES as readonly string[]).includes(record.status)) {
      throw new ConflictException({
        code: PAYMENT_ERROR_CODES.ACCEPTANCE_NOT_PAYABLE,
        message: 'Only a signed acceptance record with something left to pay is paid',
        details: { status: record.status },
      });
    }
    return {
      id: record.id,
      status: record.status,
      netPayable: Number(record.netPayable),
      paid: await this.settled(manager, record.id),
    };
  }

  private async settled(manager: EntityManager, acceptanceId: string) {
    const [{ paid }] = (await manager.query(
      `SELECT COALESCE(sum(amount), 0)::bigint AS paid FROM payments
       WHERE acceptance_id = $1 AND kind = 'settlement' AND status = 'recorded'`,
      [acceptanceId],
    )) as Array<{ paid: string }>;
    return Number(paid);
  }

  private async setRecordStatus(manager: EntityManager, id: string, status: string) {
    await manager.query(
      `UPDATE acceptance_records SET status = $2, updated_at = now() WHERE id = $1`,
      [id, status],
    );
  }

  private assertContractStatus(kind: PaymentKind, status: ContractStatus) {
    const allowed = kind === 'advance' ? ADVANCE_CONTRACT_STATUSES : REFUND_CONTRACT_STATUSES;
    if (!allowed.includes(status)) {
      throw new ConflictException({
        code: PAYMENT_ERROR_CODES.CONTRACT_STATUS,
        message:
          kind === 'advance'
            ? 'Advances are paid on active or suspended contracts'
            : 'Refunds are recorded on contracts that were activated',
        details: { status },
      });
    }
  }

  private assertCheck(error: PaymentCheckError | null) {
    if (error) {
      const { code, ...details } = error;
      throw new UnprocessableEntityException({ code, message: CHECK_MESSAGES[code], details });
    }
  }

  private async assertContractVisible(contractId: string, actor: PartnerActor) {
    try {
      await this.contracts.findVisible(contractId, actor);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw this.notFound();
      }
      throw error;
    }
  }

  private assertManage(actor: PartnerActor) {
    if (!hasPermission(actor, GO_PERMISSIONS.PAYMENT_MANAGE)) {
      throw new ForbiddenException({
        code: PAYMENT_ERROR_CODES.FORBIDDEN,
        message: 'This action needs go.payment.manage',
      });
    }
  }

  private canSeeAll(actor: PartnerActor) {
    return hasPermission(actor, GO_PERMISSIONS.CONTRACT_READ_ALL);
  }

  private notFound() {
    return new NotFoundException({
      code: PAYMENT_ERROR_CODES.NOT_FOUND,
      message: 'Payment not found',
    });
  }

  private async audit(
    actor: PartnerActor,
    action: string,
    payment: PaymentView,
    metadata: Record<string, unknown>,
  ) {
    await this.systemLog.write({
      level: 'info',
      category: PAYMENT_AUDIT_CATEGORY,
      action,
      message: `${action} ${payment.id}`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: {
        paymentId: payment.id,
        contractId: payment.contractId,
        partnerId: payment.partnerId,
        acceptanceId: payment.acceptanceId,
        kind: payment.kind,
        amount: payment.amount,
        status: payment.status,
        ...metadata,
      },
    });
  }
}
