import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { v7 as uuidv7 } from 'uuid';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { PiiCipherService } from '../../common/crypto/pii-cipher.service';
import { ListResponseDto } from '../../common/dto/list-response.dto';
import {
  AcceptanceItemEntity,
  AcceptanceItemSourceEntity,
  AcceptanceRecordEntity,
  type AcceptanceWarning,
} from '../../database/entities/acceptance.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import { buildPartnerSnapshot, ContractsService } from '../contracts/contracts.service';
import { DocumentsService } from '../documents/documents.service';
import { SystemLogService } from '../logs/system-log.service';
import { hasPermission, type PartnerActor } from '../partners/partner-actor';
import { PartnersService } from '../partners/partners.service';
import { loadAdvanceFacts } from '../payments/advance-facts';
import { advanceBalance, paymentStatus } from '../payments/payment-ledger';
import { advanceOffsetFor, calculateAmounts, lineAmount } from '../pricing-engine/amounts';
import { addBusinessDays } from '../pricing-engine/business-days';
import { PricingError } from '../pricing-engine/pricing-error';
import { contractDay } from '../project-contracts/project-delivery';
import { buildAcceptance, type BuiltAcceptance } from './acceptance-builder';
import {
  ACCEPTANCE_ACTIONS,
  AcceptanceTransitionError,
  actionLevel,
  canTransitionAcceptance,
  nextAcceptanceStatus,
  type AcceptanceAction,
} from './acceptance-state';
import type {
  AdjustItemDto,
  CreateAcceptanceDto,
  ListAcceptancesQueryDto,
  SignAcceptanceDto,
  UpdateAcceptanceDto,
} from './dto/acceptance.dto';

export const ACCEPTANCE_AUDIT_CATEGORY = 'acceptance';

export const ACCEPTANCE_ERROR_CODES = {
  NOT_FOUND: 'ACCEPTANCE_NOT_FOUND',
  ITEM_NOT_FOUND: 'ACCEPTANCE_ITEM_NOT_FOUND',
  FORBIDDEN: 'ACCEPTANCE_FORBIDDEN',
  CONTRACT_NOT_ACTIVE: 'CONTRACT_NOT_ACTIVE',
  INVALID_TRANSITION: 'ACCEPTANCE_INVALID_TRANSITION',
  LOCKED: 'ACCEPTANCE_LOCKED',
  PERIOD_INVALID: 'ACCEPTANCE_PERIOD_INVALID',
  ADJUSTMENT_REASON_REQUIRED: 'ACCEPTANCE_ADJUSTMENT_REASON_REQUIRED',
  AMOUNT_INVALID: 'ACCEPTANCE_AMOUNT_INVALID',
  EMPTY: 'ACCEPTANCE_EMPTY',
  CAP_EXCEEDED: 'ACCEPTANCE_CAP_EXCEEDED',
  APPROVAL_NOTE_REQUIRED: 'ACCEPTANCE_APPROVAL_NOTE_REQUIRED',
  UNPRICED_LINES: 'ACCEPTANCE_UNPRICED_LINES',
  SOURCE_TAKEN: 'ACCEPTANCE_SOURCE_TAKEN',
  PROFILE_INCOMPLETE: 'PARTNER_PROFILE_INCOMPLETE',
  ADVANCE_OFFSET_EXCEEDS_BALANCE: 'ACCEPTANCE_ADVANCE_OFFSET_EXCEEDS_BALANCE',
} as const;

/** Warnings that only inform; the others need the approver's note (Q-R3). */
const INFO_WARNINGS = new Set(['CAP_80_PERCENT', 'OVER_MAX_MINUTES']);

/** Tax / advance offset typed by the preparer, applied with the totals. */
type TypedAmounts = { taxAmount?: number; advanceOffsetAmount?: number };

type CapInfo = {
  capAmount: number | null;
  /** Gross of the other non-cancelled records of the contract, plus the amount accepted before AG Go. */
  otherAccepted: number;
  total: number;
  ratio: number | null;
  exceeded: boolean;
};

export type AcceptanceDetail = Omit<AcceptanceRecordEntity, 'partnerSnapshotEnc'> & {
  contract: { id: string; contractNumber: string; status: string; managerUserId: string };
  partner: { id: string; code: string; displayName: string };
  items: AcceptanceItemEntity[];
  sources: Array<
    AcceptanceItemSourceEntity & { projectName: string | null; packageCode: string | null }
  >;
  cap: CapInfo;
  hasPartnerSnapshot: boolean;
  allowedActions: AcceptanceAction[];
};

function patchRecord(manager: EntityManager, id: string, changes: Partial<AcceptanceRecordEntity>) {
  return manager.update(
    AcceptanceRecordEntity,
    id,
    changes as QueryDeepPartialEntity<AcceptanceRecordEntity>,
  );
}

function today(): string {
  return contractDay(new Date());
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505'
  );
}

/**
 * Acceptance records (BBNT, spec 6.4, 5.3): a draft gathers and prices what a contract delivered in
 * a period (BR-20) with the pure pricing engine and SQL-aggregated counts (NFR-01); lines are
 * adjusted with reasons (BR-14); tax (HALF_UP, typed tax allowed), advance offset (BR-32), net and
 * words are computed (BR-30…33); submit → approve → issue (appendix number, partner snapshot,
 * locked) → sign; the contract ceiling warns and blocks approval / issue (BR-15, FR-C-09).
 */
@Injectable()
export class AcceptancesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly contracts: ContractsService,
    private readonly partners: PartnersService,
    private readonly cipher: PiiCipherService,
    private readonly systemLog: SystemLogService,
    private readonly documents: DocumentsService,
  ) {}

  async list(query: ListAcceptancesQueryDto, actor: PartnerActor) {
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (!this.canSeeAll(actor)) where.push(`contract.manager_user_id = ${param(actor.userId)}`);
    if (query.contractId) where.push(`record.contract_id = ${param(query.contractId)}`);
    if (query.partnerId) where.push(`record.partner_id = ${param(query.partnerId)}`);
    if (query.status) where.push(`record.status = ${param(query.status)}`);
    if (query.managerUserId) {
      where.push(`contract.manager_user_id = ${param(query.managerUserId)}`);
    }
    const keyword = query.normalizedKeyword;
    if (keyword) {
      const like = param(`%${keyword.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
      where.push(
        `(contract.contract_number ILIKE ${like} OR partner.display_name ILIKE ${like} OR partner.code ILIKE ${like})`,
      );
    }
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM acceptance_records record
      INNER JOIN contracts contract ON contract.id = record.contract_id
      INNER JOIN partners partner ON partner.id = record.partner_id`;
    const [{ total }] = (await this.dataSource.query(
      `SELECT count(*)::int AS total ${from} ${filter}`,
      params,
    )) as Array<{ total: number }>;
    const rows = (await this.dataSource.query(
      `SELECT record.id, record.contract_id AS "contractId", record.partner_id AS "partnerId",
              record.pricing_model AS "pricingModel", record.appendix_number AS "appendixNumber",
              record.period_start::text AS "periodStart", record.period_end::text AS "periodEnd",
              record.record_date::text AS "recordDate", record.status,
              record.gross_amount::bigint AS "grossAmount", record.tax_amount::bigint AS "taxAmount",
              record.advance_offset_amount::bigint AS "advanceOffsetAmount",
              record.net_payable::bigint AS "netPayable", record.warnings,
              record.due_date::text AS "dueDate", record.created_at AS "createdAt",
              record.updated_at AS "updatedAt",
              contract.contract_number AS "contractNumber",
              contract.manager_user_id AS "managerUserId",
              partner.code AS "partnerCode", partner.display_name AS "partnerName"
       ${from} ${filter}
       ORDER BY record.created_at DESC, record.id DESC
       LIMIT ${param(query.pageSize)} OFFSET ${param(query.skip)}`,
      params,
    )) as Array<Record<string, unknown>>;
    return new ListResponseDto(
      rows.map((row) => ({
        ...row,
        id: row.id as string,
        status: row.status as string,
        grossAmount: Number(row.grossAmount),
        taxAmount: Number(row.taxAmount),
        advanceOffsetAmount: Number(row.advanceOffsetAmount),
        netPayable: Number(row.netPayable),
      })),
      query.page,
      query.pageSize,
      total,
    );
  }

  async get(id: string, actor: PartnerActor): Promise<AcceptanceDetail> {
    const record = await this.findVisible(this.dataSource.manager, id, actor);
    return this.detail(this.dataSource.manager, record, actor);
  }

  /** What a record of the contract would gather and price for a period, without saving it. */
  async eligible(contractId: string, periodEnd: string, actor: PartnerActor) {
    const contract = await this.contracts.findVisible(contractId, actor);
    this.assertPrepare(actor);
    const built = await buildAcceptance(this.dataSource.manager, {
      contractId: contract.id,
      periodEnd,
      excludedProjectIds: [],
      excludedPackageIds: [],
      acceptanceId: null,
    });
    return {
      periodEnd,
      pricingModel: built.pricingModel,
      rateCard: built.rateCard,
      lines: built.lines.map((line) => ({
        ...line,
        amount: lineAmount(line.quantity, line.unitPrice),
      })),
      uncounted: built.uncounted,
      warnings: built.warnings,
    };
  }

  /** Draft for a contract and period, gathered and priced at once (FR-A-01, FR-A-02). */
  async create(contractId: string, dto: CreateAcceptanceDto, actor: PartnerActor) {
    const contract = await this.contracts.findVisible(contractId, actor);
    this.assertPrepare(actor);
    if (dto.periodEnd < dto.periodStart) {
      throw new BadRequestException({
        code: ACCEPTANCE_ERROR_CODES.PERIOD_INVALID,
        message: 'periodEnd must not be before periodStart',
      });
    }
    const id = uuidv7();
    await this.inTransaction(async (manager) => {
      const [locked] = (await manager.query(
        `SELECT status FROM contracts WHERE id = $1 FOR UPDATE`,
        [contract.id],
      )) as Array<{ status: string }>;
      if (locked.status !== 'active') {
        throw new ConflictException({
          code: ACCEPTANCE_ERROR_CODES.CONTRACT_NOT_ACTIVE,
          message: 'Acceptance records are made for active contracts only',
        });
      }
      await manager.insert(AcceptanceRecordEntity, {
        id,
        contractId: contract.id,
        partnerId: contract.partnerId,
        pricingModel: contract.pricingModel,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        recordDate: dto.recordDate ?? null,
        status: 'draft',
        deliveryMethod: dto.deliveryMethod ?? 'ag_go',
        deliveryNote: dto.deliveryNote?.trim() || null,
        taxRate: dto.taxRate ?? 10,
        excludedProjectIds: [],
        excludedPackageIds: [],
        warnings: [],
        preparedBy: actor.userId,
      } as QueryDeepPartialEntity<AcceptanceRecordEntity>);
      await this.rebuild(manager, id);
    });
    const detail = await this.get(id, actor);
    await this.audit(actor, 'ACCEPTANCE_CREATED', detail, {
      periodStart: detail.periodStart,
      periodEnd: detail.periodEnd,
      grossAmount: detail.grossAmount,
    });
    return detail;
  }

  /** Header, amounts and exclusions of a draft; a new period or exclusions rebuild it. */
  async update(id: string, dto: UpdateAcceptanceDto, actor: PartnerActor) {
    this.assertPrepare(actor);
    const changed: string[] = [];
    await this.inTransaction(async (manager) => {
      const record = await this.lockDraft(manager, id, actor);
      const changes: Partial<AcceptanceRecordEntity> = {};
      // Typed amounts go through the totals (the row keeps net = gross − tax − offset).
      const typed: TypedAmounts = {};
      const set = <K extends keyof AcceptanceRecordEntity>(
        key: K,
        value: AcceptanceRecordEntity[K],
      ) => {
        if (JSON.stringify(record[key]) !== JSON.stringify(value)) {
          changes[key] = value;
          changed.push(key);
        }
      };
      if (dto.periodStart !== undefined) set('periodStart', dto.periodStart);
      if (dto.periodEnd !== undefined) set('periodEnd', dto.periodEnd);
      if ((changes.periodEnd ?? record.periodEnd) < (changes.periodStart ?? record.periodStart)) {
        throw new BadRequestException({
          code: ACCEPTANCE_ERROR_CODES.PERIOD_INVALID,
          message: 'periodEnd must not be before periodStart',
        });
      }
      if (dto.recordDate !== undefined) set('recordDate', dto.recordDate);
      if (dto.deliveryMethod !== undefined) set('deliveryMethod', dto.deliveryMethod);
      if (dto.deliveryNote !== undefined) set('deliveryNote', dto.deliveryNote?.trim() || null);
      if (dto.taxRate !== undefined) set('taxRate', dto.taxRate);
      if (dto.taxAmount !== undefined) {
        if (dto.taxAmount === null) {
          set('taxOverridden', false);
          set('taxOverrideReason', null);
        } else {
          this.requireReason(dto.taxOverrideReason, 'taxOverrideReason');
          set('taxOverridden', true);
          typed.taxAmount = dto.taxAmount;
          changed.push('taxAmount');
          set('taxOverrideReason', dto.taxOverrideReason!.trim());
        }
      }
      if (dto.advanceOffsetAmount !== undefined) {
        if (dto.advanceOffsetAmount === null) {
          set('advanceOffsetOverridden', false);
          set('advanceOffsetReason', null);
        } else {
          this.requireReason(dto.advanceOffsetReason, 'advanceOffsetReason');
          set('advanceOffsetOverridden', true);
          typed.advanceOffsetAmount = dto.advanceOffsetAmount;
          changed.push('advanceOffsetAmount');
          set('advanceOffsetReason', dto.advanceOffsetReason!.trim());
        }
      }
      if (dto.excludedProjectIds !== undefined) {
        set('excludedProjectIds', [...new Set(dto.excludedProjectIds)].sort());
      }
      if (dto.excludedPackageIds !== undefined) {
        set('excludedPackageIds', [...new Set(dto.excludedPackageIds)].sort());
      }
      if (changed.length === 0) {
        return;
      }
      await patchRecord(manager, id, changes);
      const rebuild = ['periodEnd', 'excludedProjectIds', 'excludedPackageIds'].some((key) =>
        changed.includes(key),
      );
      if (rebuild) {
        await this.rebuild(manager, id, typed);
      } else {
        await this.recomputeTotals(manager, id, undefined, typed);
      }
    });
    const detail = await this.get(id, actor);
    if (changed.length > 0) {
      await this.audit(actor, 'ACCEPTANCE_UPDATED', detail, { fields: changed });
    }
    return detail;
  }

  /** Adjusts one line of a draft (FR-A-03): a reason whenever it differs from the computed values. */
  async adjustItem(id: string, itemId: string, dto: AdjustItemDto, actor: PartnerActor) {
    this.assertPrepare(actor);
    const change = await this.inTransaction(async (manager) => {
      await this.lockDraft(manager, id, actor);
      const item = await manager.findOne(AcceptanceItemEntity, {
        where: { id: itemId, acceptanceId: id },
      });
      if (!item) {
        throw new NotFoundException({
          code: ACCEPTANCE_ERROR_CODES.ITEM_NOT_FOUND,
          message: 'Line not found',
        });
      }
      const before = { quantity: item.quantity, unitPrice: item.unitPrice, amount: item.amount };
      const quantity = dto.quantity ?? item.quantity;
      const unitPrice = dto.unitPrice ?? item.unitPrice;
      const adjusted = quantity !== item.computedQuantity || unitPrice !== item.computedUnitPrice;
      const reason = dto.reason?.trim() || (adjusted ? item.adjustmentReason : null);
      if (adjusted && !reason) {
        throw new BadRequestException({
          code: ACCEPTANCE_ERROR_CODES.ADJUSTMENT_REASON_REQUIRED,
          message:
            'A reason is required when the quantity or unit price differs from the computed one',
        });
      }
      item.quantity = quantity;
      item.unitPrice = unitPrice;
      item.amount = this.money(() => lineAmount(quantity, unitPrice));
      item.adjustmentReason = adjusted ? reason : null;
      item.adjustedBy = adjusted ? actor.userId : null;
      item.adjustedAt = adjusted ? new Date() : null;
      if (dto.productLabel !== undefined) {
        item.productLabel = dto.productLabel.trim();
      }
      await manager.save(item);
      await this.recomputeTotals(manager, id);
      return {
        itemId,
        lineNo: item.lineNo,
        before,
        after: { quantity, unitPrice, amount: item.amount },
        computed: {
          quantity: item.computedQuantity,
          unitPrice: item.computedUnitPrice,
          amount: item.computedAmount,
        },
        reason: item.adjustmentReason,
      };
    });
    const detail = await this.get(id, actor);
    await this.audit(actor, 'ACCEPTANCE_ITEM_ADJUSTED', detail, change);
    return detail;
  }

  /** Gathers and prices again from the latest data, keeping adjustments of lines still there. */
  async recalculate(id: string, actor: PartnerActor) {
    this.assertPrepare(actor);
    await this.inTransaction(async (manager) => {
      await this.lockDraft(manager, id, actor);
      await this.rebuild(manager, id);
    });
    const detail = await this.get(id, actor);
    await this.audit(actor, 'ACCEPTANCE_RECALCULATED', detail, { grossAmount: detail.grossAmount });
    return detail;
  }

  submit(id: string, actor: PartnerActor) {
    return this.transition(id, 'submit', actor, async (record, manager) => {
      const [{ count }] = (await manager.query(
        `SELECT count(*)::int AS count FROM acceptance_items WHERE acceptance_id = $1 AND amount > 0`,
        [id],
      )) as Array<{ count: number }>;
      if (count === 0) {
        throw new UnprocessableEntityException({
          code: ACCEPTANCE_ERROR_CODES.EMPTY,
          message: 'The acceptance record has nothing to pay',
        });
      }
      return {
        submittedAt: new Date(),
        submittedBy: actor.userId,
        returnReason: null,
        returnedAt: null,
        returnedBy: null,
      };
    });
  }

  returnRecord(id: string, reason: string, actor: PartnerActor) {
    return this.transition(
      id,
      'return',
      actor,
      () => ({ returnReason: reason.trim(), returnedAt: new Date(), returnedBy: actor.userId }),
      { reason: reason.trim() },
    );
  }

  /** submitted → approved; blocked over the ceiling, and warnings need the approver's note. */
  approve(id: string, note: string | undefined, actor: PartnerActor) {
    return this.transition(
      id,
      'approve',
      actor,
      async (record, manager) => {
        await this.assertCap(manager, record);
        const blocking = record.warnings.filter((warning) => !INFO_WARNINGS.has(warning.code));
        if (blocking.length > 0 && !note?.trim()) {
          throw new UnprocessableEntityException({
            code: ACCEPTANCE_ERROR_CODES.APPROVAL_NOTE_REQUIRED,
            message: 'The record has warnings: record your decision in the note',
            details: { warnings: blocking },
          });
        }
        return {
          approvedAt: new Date(),
          approvedBy: actor.userId,
          approvalNote: note?.trim() || null,
        };
      },
      { note: note?.trim() || null },
    );
  }

  /**
   * approved → issued (FR-A-07, BR-07, BR-02): contract active, every paid line priced, within the
   * ceiling, the partner profile read from AG Account and stored encrypted, the next appendix number
   * of the contract; packages become `accepted` and the content is locked.
   */
  async issue(id: string, actor: PartnerActor) {
    const record = await this.findVisible(this.dataSource.manager, id, actor);
    this.assertLevel('issue', record, actor);
    // Checked again under the lock; early so a wrong status is not reported as missing data.
    this.assertTransition(record, 'issue');
    const partner = await this.dataSource.getRepository(PartnerEntity).findOneByOrFail({
      id: record.partnerId,
    });
    const { profile, completeness } = await this.partners.readProfileForDocument(partner, actor);
    if (!completeness.complete) {
      throw new UnprocessableEntityException({
        code: ACCEPTANCE_ERROR_CODES.PROFILE_INCOMPLETE,
        message: 'The partner profile misses fields required on the acceptance record',
        details: { missing: completeness.missing },
      });
    }
    const now = new Date();
    const partnerSnapshot = buildPartnerSnapshot(partner, profile, now);
    // Party A, template and no empty placeholder before the number is taken (FR-D-03).
    const prepared = await this.documents.prepareIssue('acceptance', id, partnerSnapshot);
    const snapshot = this.cipher.encryptJson(partnerSnapshot);
    const issued = await this.transition(id, 'issue', actor, async (locked, manager) => {
      const [contract] = (await manager.query(
        `SELECT status, last_appendix_number AS "last" FROM contracts WHERE id = $1 FOR UPDATE`,
        [locked.contractId],
      )) as Array<{ status: string; last: number }>;
      if (contract.status !== 'active') {
        throw new ConflictException({
          code: ACCEPTANCE_ERROR_CODES.CONTRACT_NOT_ACTIVE,
          message: 'Only an active contract issues acceptance records',
        });
      }
      const unpriced = (await manager.query(
        `SELECT line_no AS "lineNo", product_label AS "productLabel" FROM acceptance_items
         WHERE acceptance_id = $1 AND unit_price = 0 AND quantity > 0 ORDER BY line_no`,
        [id],
      )) as Array<{ lineNo: number; productLabel: string }>;
      if (unpriced.length > 0) {
        throw new UnprocessableEntityException({
          code: ACCEPTANCE_ERROR_CODES.UNPRICED_LINES,
          message: 'Some lines have no price in the contract',
          details: { lines: unpriced },
        });
      }
      await this.assertCap(manager, locked);
      // The advance actually paid may have changed since the draft was priced (payments).
      const available = await this.advanceAvailable(manager, locked);
      if (locked.advanceOffsetAmount > available) {
        throw new ConflictException({
          code: ACCEPTANCE_ERROR_CODES.ADVANCE_OFFSET_EXCEEDS_BALANCE,
          message:
            'The advance offset is more than the advance paid and not yet offset: return the record and recalculate',
          details: { advanceOffsetAmount: locked.advanceOffsetAmount, available },
        });
      }
      const appendix = Number(contract.last) + 1;
      await manager.query(
        `UPDATE contracts SET last_appendix_number = $2, updated_at = now() WHERE id = $1`,
        [locked.contractId, appendix],
      );
      await manager.query(
        `UPDATE product_packages SET status = 'accepted', updated_at = now()
         WHERE acceptance_id = $1 AND status = 'evaluated'`,
        [id],
      );
      return {
        appendixNumber: appendix,
        issuedAt: now,
        issuedBy: actor.userId,
        recordDate: locked.recordDate ?? today(),
        partnerSnapshotEnc: snapshot,
        partnerSnapshotAt: now,
        companySnapshot: prepared.companySnapshot,
        templateVersionId: prepared.templateId,
      };
    });
    await this.documents.requestGeneration({
      ownerType: 'acceptance',
      ownerId: id,
      templateId: prepared.templateId,
      actor,
    });
    return issued;
  }

  /**
   * issued → signed: signed copy and payment due date (BR-34, weekends skipped). A record with
   * nothing to pay (the advance offset covers it, TC-4) is `paid` at once (FR-$-02).
   */
  async sign(id: string, dto: SignAcceptanceDto, actor: PartnerActor) {
    if (dto.signedFileId) {
      await this.documents.assertSignedFile('acceptance', id, dto.signedFileId);
    }
    return this.transition(id, 'sign', actor, async (record, manager) => {
      const [contract] = (await manager.query(
        `SELECT payment_term_business_days AS "days" FROM contracts WHERE id = $1`,
        [record.contractId],
      )) as Array<{ days: number }>;
      const signedDay = dto.signedDate ?? today();
      return {
        status: paymentStatus(record.netPayable, 0),
        signedAt: new Date(`${signedDay}T00:00:00+07:00`),
        signedFileId: dto.signedFileId ?? record.signedFileId,
        dueDate: addBusinessDays(signedDay, Number(contract.days)),
      };
    });
  }

  /** → cancelled with a reason; counted projects and packages are released (number not reused). */
  cancel(id: string, reason: string, actor: PartnerActor) {
    return this.transition(
      id,
      'cancel',
      actor,
      async (record, manager) => {
        await manager.query(
          `UPDATE acceptance_item_sources SET is_active = false WHERE acceptance_id = $1`,
          [id],
        );
        await manager.query(
          `UPDATE product_packages
           SET status = CASE WHEN status = 'accepted' THEN 'evaluated' ELSE status END,
               acceptance_id = NULL, acceptance_item_id = NULL, updated_at = now()
           WHERE acceptance_id = $1`,
          [id],
        );
        return {
          cancelledReason: reason.trim(),
          cancelledAt: new Date(),
          cancelledBy: actor.userId,
        };
      },
      { reason: reason.trim() },
    );
  }

  // -------------------------------------------------------------------------
  // Building and totals
  // -------------------------------------------------------------------------

  /** Replaces the lines and sources of a draft from the latest data and recomputes its totals. */
  private async rebuild(manager: EntityManager, id: string, typed: TypedAmounts = {}) {
    const record = await manager.findOneOrFail(AcceptanceRecordEntity, { where: { id } });
    const previous = await manager.find(AcceptanceItemEntity, { where: { acceptanceId: id } });
    const adjustments = new Map(
      previous.filter((item) => item.adjustmentReason).map((item) => [item.lineKey, item] as const),
    );
    const labels = new Map(previous.map((item) => [item.lineKey, item.productLabel] as const));
    await manager.query(
      `UPDATE product_packages SET acceptance_id = NULL, acceptance_item_id = NULL WHERE acceptance_id = $1`,
      [id],
    );
    await manager.delete(AcceptanceItemSourceEntity, { acceptanceId: id });
    await manager.delete(AcceptanceItemEntity, { acceptanceId: id });

    const built = await buildAcceptance(manager, {
      contractId: record.contractId,
      periodEnd: record.periodEnd,
      excludedProjectIds: record.excludedProjectIds,
      excludedPackageIds: record.excludedPackageIds,
      acceptanceId: id,
    });
    await this.writeLines(manager, id, built, adjustments, labels);
    await patchRecord(manager, id, {
      rateCardId: built.rateCard?.id ?? null,
      termsSnapshot: built.termsSnapshot,
      calculatedAt: new Date(),
      warnings: built.warnings,
    });
    await this.recomputeTotals(manager, id, built.warnings, typed);
  }

  private async writeLines(
    manager: EntityManager,
    id: string,
    built: BuiltAcceptance,
    adjustments: Map<string, AcceptanceItemEntity>,
    labels: Map<string, string>,
  ) {
    const sources: Array<QueryDeepPartialEntity<AcceptanceItemSourceEntity>> = [];
    let lineNo = 0;
    for (const line of built.lines) {
      lineNo += 1;
      const itemId = uuidv7();
      const computedAmount = this.money(() => lineAmount(line.quantity, line.unitPrice));
      const adjusted = adjustments.get(line.lineKey);
      const quantity = adjusted ? adjusted.quantity : line.quantity;
      const unitPrice = adjusted ? adjusted.unitPrice : line.unitPrice;
      const keepsAdjustment =
        adjusted !== undefined && (quantity !== line.quantity || unitPrice !== line.unitPrice);
      await manager.insert(AcceptanceItemEntity, {
        id: itemId,
        acceptanceId: id,
        lineNo,
        lineKey: line.lineKey,
        productLabel: labels.get(line.lineKey) ?? line.productLabel,
        categoryId: line.categoryId,
        packageId: line.packageId,
        level: line.level,
        rateCardItemId: line.rateCardItemId,
        unit: line.unit,
        computedQuantity: line.quantity,
        quantity: keepsAdjustment ? quantity : line.quantity,
        computedUnitPrice: line.unitPrice,
        unitPrice: keepsAdjustment ? unitPrice : line.unitPrice,
        computedAmount,
        amount: keepsAdjustment
          ? this.money(() => lineAmount(quantity, unitPrice))
          : computedAmount,
        metrics: line.metrics,
        adjustmentReason: keepsAdjustment ? adjusted.adjustmentReason : null,
        adjustedBy: keepsAdjustment ? adjusted.adjustedBy : null,
        adjustedAt: keepsAdjustment ? adjusted.adjustedAt : null,
      } as QueryDeepPartialEntity<AcceptanceItemEntity>);
      if (line.unit === 'package' && line.packageId) {
        await manager.query(
          `UPDATE product_packages SET acceptance_id = $2, acceptance_item_id = $3 WHERE id = $1`,
          [line.packageId, id, itemId],
        );
      }
      for (const source of line.sources) {
        sources.push(this.sourceRow(id, itemId, source, true));
      }
    }
    for (const source of built.uncounted) {
      sources.push(this.sourceRow(id, null, source, false));
    }
    if (sources.length > 0) {
      await manager.insert(AcceptanceItemSourceEntity, sources);
    }
  }

  private sourceRow(
    acceptanceId: string,
    itemId: string | null,
    source: BuiltAcceptance['uncounted'][number],
    counted: boolean,
  ): QueryDeepPartialEntity<AcceptanceItemSourceEntity> {
    return {
      id: uuidv7(),
      acceptanceId,
      acceptanceItemId: itemId,
      projectId: source.projectId,
      projectMediaId: null,
      packageId: source.packageId,
      counted,
      exclusionReason: counted ? null : source.reason,
      exclusionMessage: counted ? null : source.message,
      quantity: source.quantity,
      metrics: source.metrics,
      isActive: counted,
    } as QueryDeepPartialEntity<AcceptanceItemSourceEntity>;
  }

  /**
   * Gross from the lines (SQL sum), tax (rate HALF_UP or typed), advance offset (BR-32 or typed),
   * net and words, ceiling warnings. A typed tax or offset that no longer fits is dropped with a
   * warning.
   */
  private async recomputeTotals(
    manager: EntityManager,
    id: string,
    buildWarnings?: AcceptanceWarning[],
    typed: TypedAmounts = {},
  ) {
    const record = await manager.findOneOrFail(AcceptanceRecordEntity, { where: { id } });
    if (typed.taxAmount !== undefined) {
      record.taxAmount = typed.taxAmount;
    }
    if (typed.advanceOffsetAmount !== undefined) {
      record.advanceOffsetAmount = typed.advanceOffsetAmount;
    }
    const [{ gross }] = (await manager.query(
      `SELECT COALESCE(sum(amount), 0)::bigint AS gross FROM acceptance_items WHERE acceptance_id = $1`,
      [id],
    )) as Array<{ gross: string }>;
    const grossAmount = Number(gross);
    const warnings = (buildWarnings ?? record.warnings).filter(
      (warning) =>
        ![
          'CAP_80_PERCENT',
          'CAP_EXCEEDED',
          'TAX_OVERRIDE_DROPPED',
          'ADVANCE_OVERRIDE_DROPPED',
        ].includes(warning.code),
    );
    let taxOverridden = record.taxOverridden;
    if (taxOverridden && record.taxAmount > grossAmount) {
      taxOverridden = false;
      warnings.push({
        code: 'TAX_OVERRIDE_DROPPED',
        message: 'Thuế nhập tay lớn hơn tổng giá trị mới nên đã tính lại theo tỷ lệ',
      });
    }
    const base = this.money(() =>
      calculateAmounts({
        lineAmounts: [grossAmount],
        taxRatePercent: record.taxRate,
        taxOverride: taxOverridden ? record.taxAmount : null,
      }),
    );
    const contract = await this.contractMoney(manager, record);
    let advanceOverridden = record.advanceOffsetOverridden;
    if (advanceOverridden && record.advanceOffsetAmount > grossAmount - base.tax) {
      advanceOverridden = false;
      warnings.push({
        code: 'ADVANCE_OVERRIDE_DROPPED',
        message: 'Đối trừ tạm ứng nhập tay lớn hơn tổng trừ thuế nên đã tính lại',
      });
    } else if (advanceOverridden && record.advanceOffsetAmount > contract.advanceRemaining) {
      advanceOverridden = false;
      warnings.push({
        code: 'ADVANCE_OVERRIDE_DROPPED',
        message: 'Đối trừ tạm ứng nhập tay lớn hơn số dư tạm ứng đã chi nên đã tính lại',
      });
    }
    const advanceOffset = advanceOverridden
      ? record.advanceOffsetAmount
      : this.money(() =>
          advanceOffsetFor({
            rule: contract.advanceOffsetRule,
            gross: grossAmount,
            tax: base.tax,
            advanceRemaining: contract.advanceRemaining,
            advanceAmount: contract.advanceAmount,
            capAmount: contract.capAmount,
          }),
        );
    const amounts = this.money(() =>
      calculateAmounts({
        lineAmounts: [grossAmount],
        taxRatePercent: record.taxRate,
        taxOverride: taxOverridden ? record.taxAmount : null,
        advanceOffset,
      }),
    );
    const cap = await this.capInfo(manager, record, grossAmount);
    if (cap.exceeded) {
      warnings.push({
        code: 'CAP_EXCEEDED',
        message: `Vượt trần HĐ: ${cap.total.toLocaleString('de-DE')} > ${cap.capAmount!.toLocaleString('de-DE')} đồng (cần phụ lục nâng trần)`,
      });
    } else if (cap.ratio !== null && cap.ratio >= 0.8) {
      warnings.push({
        code: 'CAP_80_PERCENT',
        message: `Đã dùng ${Math.round(cap.ratio * 100)}% trần HĐ`,
      });
    }
    await patchRecord(manager, id, {
      grossAmount: amounts.gross,
      taxAmount: amounts.tax,
      taxOverridden: amounts.taxOverridden,
      taxOverrideReason: amounts.taxOverridden ? record.taxOverrideReason : null,
      advanceOffsetAmount: amounts.advanceOffset,
      advanceOffsetOverridden: advanceOverridden,
      advanceOffsetReason: advanceOverridden ? record.advanceOffsetReason : null,
      netPayable: amounts.net,
      netPayableWords: amounts.netWords,
      warnings,
    });
  }

  /** Advance still to offset and the money terms of the contract (on the period's last day). */
  private async contractMoney(manager: EntityManager, record: AcceptanceRecordEntity) {
    const facts = await loadAdvanceFacts(manager, record.contractId, record.id);
    const cap = record.termsSnapshot?.cap_amount;
    return {
      advanceAmount: facts.advanceAmount,
      advanceRemaining: Math.max(
        0,
        advanceBalance({ ...facts, offsets: facts.offsetsIssued + facts.offsetsPending }),
      ),
      advanceOffsetRule: facts.advanceOffsetRule,
      capAmount: cap === null || cap === undefined ? null : Number(cap),
    };
  }

  /**
   * Advance a record can offset (BR-32): advances actually paid (payments) plus the balance of an
   * imported contract, minus refunds and the offsets of the other records not cancelled (issued
   * ones are final, drafts in progress reserve theirs so the advance is never offset twice).
   */
  private async advanceAvailable(manager: EntityManager, record: AcceptanceRecordEntity) {
    return (await this.contractMoney(manager, record)).advanceRemaining;
  }

  /**
   * Totals of the draft records of a contract computed again, oldest first, after its advance
   * changed (an advance or refund recorded or cancelled). Runs in the caller's transaction.
   */
  async recomputeDrafts(manager: EntityManager, contractId: string) {
    const drafts = (await manager.query(
      `SELECT id FROM acceptance_records WHERE contract_id = $1 AND status = 'draft'
       ORDER BY created_at, id FOR UPDATE`,
      [contractId],
    )) as Array<{ id: string }>;
    for (const draft of drafts) {
      await this.recomputeTotals(manager, draft.id);
    }
    return drafts.map((draft) => draft.id);
  }

  /** BR-15 / FR-C-09: the contract ceiling (terms on the period's last day) against every record. */
  private async capInfo(
    manager: EntityManager,
    record: AcceptanceRecordEntity,
    grossAmount: number,
  ): Promise<CapInfo> {
    const cap = record.termsSnapshot?.cap_amount;
    const capAmount = cap === null || cap === undefined ? null : Number(cap);
    const [row] = (await manager.query(
      `SELECT COALESCE(contract.legacy_accepted_amount, 0)::bigint
                + COALESCE((SELECT sum(other.gross_amount) FROM acceptance_records other
                            WHERE other.contract_id = contract.id AND other.status <> 'cancelled'
                              AND other.id <> $2), 0)::bigint AS other
       FROM contracts contract WHERE contract.id = $1`,
      [record.contractId, record.id],
    )) as Array<{ other: string }>;
    const otherAccepted = Number(row.other);
    const total = otherAccepted + grossAmount;
    return {
      capAmount,
      otherAccepted,
      total,
      ratio: capAmount ? Math.round((total / capAmount) * 10_000) / 10_000 : null,
      exceeded: capAmount !== null && total > capAmount,
    };
  }

  private async assertCap(manager: EntityManager, record: AcceptanceRecordEntity) {
    const cap = await this.capInfo(manager, record, record.grossAmount);
    if (cap.exceeded) {
      throw new ConflictException({
        code: ACCEPTANCE_ERROR_CODES.CAP_EXCEEDED,
        message: 'The contract ceiling would be exceeded: sign an amendment raising it first',
        details: cap,
      });
    }
  }

  // -------------------------------------------------------------------------

  private async transition(
    id: string,
    action: AcceptanceAction,
    actor: PartnerActor,
    apply: (
      record: AcceptanceRecordEntity,
      manager: EntityManager,
    ) => Partial<AcceptanceRecordEntity> | Promise<Partial<AcceptanceRecordEntity>>,
    metadata: Record<string, unknown> = {},
  ) {
    const from = await this.inTransaction(async (manager) => {
      const record = await this.lock(manager, id, actor);
      this.assertLevel(action, record, actor);
      const status = this.assertTransition(record, action);
      const changes = await apply(record, manager);
      // `apply` may settle on another status of the same step (sign → paid when nothing to pay).
      await patchRecord(manager, id, { status, ...changes });
      return record.status;
    });
    const detail = await this.get(id, actor);
    await this.audit(actor, `ACCEPTANCE_${action.toUpperCase()}`, detail, {
      from,
      to: detail.status,
      ...metadata,
    });
    return detail;
  }

  private async detail(
    manager: EntityManager,
    record: AcceptanceRecordEntity,
    actor: PartnerActor,
  ): Promise<AcceptanceDetail> {
    const [contract] = (await manager.query(
      `SELECT contract.id, contract.contract_number AS "contractNumber", contract.status,
              contract.manager_user_id AS "managerUserId",
              partner.id AS "partnerId", partner.code AS "partnerCode",
              partner.display_name AS "partnerName"
       FROM contracts contract INNER JOIN partners partner ON partner.id = contract.partner_id
       WHERE contract.id = $1`,
      [record.contractId],
    )) as Array<Record<string, string>>;
    const items = await manager.find(AcceptanceItemEntity, {
      where: { acceptanceId: record.id },
      order: { lineNo: 'ASC' },
    });
    const sources = (await manager.query(
      `SELECT source.id, source.acceptance_id AS "acceptanceId",
              source.acceptance_item_id AS "acceptanceItemId", source.project_id AS "projectId",
              source.project_media_id AS "projectMediaId", source.package_id AS "packageId",
              source.counted, source.exclusion_reason AS "exclusionReason",
              source.exclusion_message AS "exclusionMessage", source.quantity::float AS quantity,
              source.metrics, source.is_active AS "isActive",
              project.name AS "projectName", package.code AS "packageCode"
       FROM acceptance_item_sources source
       LEFT JOIN projects project ON project.id = source.project_id
       LEFT JOIN product_packages package ON package.id = source.package_id
       WHERE source.acceptance_id = $1
       ORDER BY source.counted DESC, package.code ASC NULLS FIRST, project.name ASC`,
      [record.id],
    )) as AcceptanceDetail['sources'];
    const { partnerSnapshotEnc, ...rest } = record as AcceptanceRecordEntity & {
      partnerSnapshotEnc?: string | null;
    };
    void partnerSnapshotEnc;
    return {
      ...rest,
      contract: {
        id: contract.id,
        contractNumber: contract.contractNumber,
        status: contract.status,
        managerUserId: contract.managerUserId,
      },
      partner: {
        id: contract.partnerId,
        code: contract.partnerCode,
        displayName: contract.partnerName,
      },
      items,
      sources,
      cap: await this.capInfo(manager, record, record.grossAmount),
      hasPartnerSnapshot: record.partnerSnapshotAt !== null,
      allowedActions: ACCEPTANCE_ACTIONS.filter(
        (action) =>
          canTransitionAcceptance(record.status, action) &&
          this.hasLevel(actionLevel(action, record.status), actor),
      ),
    };
  }

  private async findVisible(manager: EntityManager, id: string, actor: PartnerActor) {
    const record = await manager.findOne(AcceptanceRecordEntity, { where: { id } });
    if (!record) {
      throw this.notFound();
    }
    try {
      await this.contracts.findVisible(record.contractId, actor);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw this.notFound();
      }
      throw error;
    }
    return record;
  }

  private async lock(manager: EntityManager, id: string, actor: PartnerActor) {
    await manager.query(`SELECT id FROM acceptance_records WHERE id = $1 FOR UPDATE`, [id]);
    return this.findVisible(manager, id, actor);
  }

  private async lockDraft(manager: EntityManager, id: string, actor: PartnerActor) {
    const record = await this.lock(manager, id, actor);
    if (record.status !== 'draft') {
      throw new ConflictException({
        code: ACCEPTANCE_ERROR_CODES.LOCKED,
        message: 'Only a draft acceptance record can be changed (return it first)',
      });
    }
    return record;
  }

  private assertTransition(record: AcceptanceRecordEntity, action: AcceptanceAction) {
    try {
      return nextAcceptanceStatus(record.status, action);
    } catch (error) {
      if (error instanceof AcceptanceTransitionError) {
        throw new ConflictException({
          code: ACCEPTANCE_ERROR_CODES.INVALID_TRANSITION,
          message: error.message,
          details: { status: record.status, action },
        });
      }
      throw error;
    }
  }

  private hasLevel(level: 'prepare' | 'approve', actor: PartnerActor) {
    return hasPermission(
      actor,
      level === 'prepare' ? GO_PERMISSIONS.ACCEPTANCE_PREPARE : GO_PERMISSIONS.ACCEPTANCE_APPROVE,
    );
  }

  private assertLevel(
    action: AcceptanceAction,
    record: AcceptanceRecordEntity,
    actor: PartnerActor,
  ) {
    const level = actionLevel(action, record.status);
    if (!this.hasLevel(level, actor)) {
      throw new ForbiddenException({
        code: ACCEPTANCE_ERROR_CODES.FORBIDDEN,
        message: `This action needs go.acceptance.${level}`,
      });
    }
  }

  private assertPrepare(actor: PartnerActor) {
    if (!this.hasLevel('prepare', actor)) {
      throw new ForbiddenException({
        code: ACCEPTANCE_ERROR_CODES.FORBIDDEN,
        message: 'This action needs go.acceptance.prepare',
      });
    }
  }

  private canSeeAll(actor: PartnerActor) {
    return hasPermission(actor, GO_PERMISSIONS.CONTRACT_READ_ALL);
  }

  private requireReason(reason: string | undefined, field: string) {
    if (!reason?.trim()) {
      throw new BadRequestException({
        code: ACCEPTANCE_ERROR_CODES.ADJUSTMENT_REASON_REQUIRED,
        message: `${field} is required with a typed amount`,
      });
    }
  }

  /** Runs a pricing function, mapping its errors to 400. */
  private money<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof PricingError) {
        throw new BadRequestException({
          code: ACCEPTANCE_ERROR_CODES.AMOUNT_INVALID,
          message: error.message,
        });
      }
      throw error;
    }
  }

  /** A transaction that maps a project counted twice (unique index race) to 409. */
  private async inTransaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: ACCEPTANCE_ERROR_CODES.SOURCE_TAKEN,
          message: 'A project is already counted on another acceptance record; recalculate',
        });
      }
      throw error;
    }
  }

  private notFound() {
    return new NotFoundException({
      code: ACCEPTANCE_ERROR_CODES.NOT_FOUND,
      message: 'Acceptance record not found',
    });
  }

  private async audit(
    actor: PartnerActor,
    action: string,
    record: Pick<AcceptanceDetail, 'id' | 'contractId' | 'partnerId' | 'status' | 'appendixNumber'>,
    metadata: Record<string, unknown>,
  ) {
    await this.systemLog.write({
      level: 'info',
      category: ACCEPTANCE_AUDIT_CATEGORY,
      action,
      message: `${action} ${record.id}`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: {
        acceptanceId: record.id,
        contractId: record.contractId,
        partnerId: record.partnerId,
        appendixNumber: record.appendixNumber,
        ...metadata,
      },
    });
  }
}
