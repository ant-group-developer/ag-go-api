import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { SystemLogService } from '../logs/system-log.service';
import { hasPermission, type PartnerActor } from '../partners/partner-actor';
import { contractDay } from '../project-contracts/project-delivery';
import type {
  AcceptanceStatusReportQueryDto,
  PaymentReportQueryDto,
  ReportExportQueryDto,
  TaxReportQueryDto,
} from './dto/payment.dto';
import { buildWorkbook, sheet, type ExcelSheet } from './payment-excel';
import { buildLedger, remainingPayable, type CapAlert } from './payment-ledger';
import { PAYMENT_AUDIT_CATEGORY, PaymentsService } from './payments.service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Contracts that carry money: activated at some point. */
const LEDGER_CONTRACT_STATUSES = ['active', 'suspended', 'completed', 'terminated'];

const KIND_LABELS: Record<string, string> = {
  advance: 'Tạm ứng',
  settlement: 'Thanh toán BBNT',
  refund: 'Hoàn tạm ứng',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'Nháp',
  submitted: 'Chờ duyệt',
  approved: 'Đã duyệt',
  issued: 'Đã phát hành',
  signed: 'Đã ký',
  partially_paid: 'Đã chi một phần',
  paid: 'Đã chi đủ',
  cancelled: 'Đã huỷ',
};

export type PayableRow = {
  contractId: string;
  contractNumber: string;
  contractStatus: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  managerUserId: string;
  acceptedAmount: number;
  grossAmount: number;
  taxAmount: number;
  advanceOffsetAmount: number;
  netPayable: number;
  settlementsPaid: number;
  legacyPaidAmount: number;
  advancesPaid: number;
  refunds: number;
  advanceBalance: number;
  outstanding: number;
  overdueAmount: number;
  overdueCount: number;
  capAmount: number | null;
  capRatio: number | null;
  capAlert: CapAlert;
  refundDue: number;
};

const SUMMED_PAYABLE_KEYS = [
  'acceptedAmount',
  'grossAmount',
  'taxAmount',
  'advanceOffsetAmount',
  'netPayable',
  'settlementsPaid',
  'legacyPaidAmount',
  'advancesPaid',
  'refunds',
  'advanceBalance',
  'outstanding',
  'overdueAmount',
  'overdueCount',
  'refundDue',
] as const satisfies ReadonlyArray<keyof PayableRow>;

type SummedPayable = Record<(typeof SUMMED_PAYABLE_KEYS)[number], number>;

function emptyTotals(): SummedPayable {
  return Object.fromEntries(SUMMED_PAYABLE_KEYS.map((key) => [key, 0])) as SummedPayable;
}

function addTotals(target: SummedPayable, row: PayableRow) {
  for (const key of SUMMED_PAYABLE_KEYS) {
    target[key] += row[key];
  }
}

export type PaymentReportItem = {
  id: string;
  kind: 'advance' | 'settlement' | 'refund';
  amount: number;
  paidDate: string;
  method: string;
  reference: string | null;
  contractId: string;
  contractNumber: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  acceptanceId: string | null;
  appendixNumber: number | null;
};

export type AcceptanceReportItem = {
  id: string;
  status: string;
  appendixNumber: number | null;
  periodStart: string;
  periodEnd: string;
  recordDate: string;
  dueDate: string | null;
  grossAmount: number;
  taxAmount: number;
  advanceOffsetAmount: number;
  netPayable: number;
  paid: number;
  remaining: number;
  contractId: string;
  contractNumber: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
};

function money(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * Reports of the payments module (spec 6.7, FR-$-04/05, FR-R-01/04/05): payables by contract and
 * partner (the contract ledger for many contracts at once), payments by period, acceptance records
 * by status, personal income tax withheld per partner and year; each one also as Excel. Scoped to
 * the contracts one manages without go.contract.read_all.
 */
@Injectable()
export class PaymentReportsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly payments: PaymentsService,
    private readonly systemLog: SystemLogService,
  ) {}

  /** Payables now (FR-$-04 for many contracts): one row per contract, totals per partner. */
  async payables(query: PaymentReportQueryDto, actor: PartnerActor) {
    const asOf = contractDay(new Date());
    const where = [`contract.status = ANY($1::text[])`];
    const params: unknown[] = [LEDGER_CONTRACT_STATUSES];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const manager = this.scopeManager(query.managerUserId, actor);
    if (manager) where.push(`contract.manager_user_id = ${param(manager)}`);
    if (query.partnerId) where.push(`contract.partner_id = ${param(query.partnerId)}`);
    if (query.contractId) where.push(`contract.id = ${param(query.contractId)}`);
    const contracts = (await this.dataSource.query(
      `SELECT contract.id, contract.contract_number AS "contractNumber", contract.status,
              contract.partner_id AS "partnerId", contract.manager_user_id AS "managerUserId",
              contract.cap_amount::bigint AS "capAmount",
              contract.advance_amount::bigint AS "advanceAmount",
              contract.penalty_percent::float AS "penaltyPercent",
              contract.legacy_accepted_amount::bigint AS "legacyAcceptedAmount",
              contract.legacy_paid_amount::bigint AS "legacyPaidAmount",
              CASE WHEN contract.source = 'legacy_import' THEN contract.legacy_advance_balance END::bigint
                AS "legacyAdvanceBalance",
              partner.code AS "partnerCode", partner.display_name AS "partnerName",
              COALESCE(money.advances, 0)::bigint AS "advancesPaid",
              COALESCE(money.refunds, 0)::bigint AS refunds,
              COALESCE(pending.offsets, 0)::bigint AS "pendingOffsets"
       FROM contracts contract
       INNER JOIN partners partner ON partner.id = contract.partner_id
       LEFT JOIN LATERAL (
         SELECT sum(amount) FILTER (WHERE kind = 'advance') AS advances,
                sum(amount) FILTER (WHERE kind = 'refund') AS refunds
         FROM payments WHERE contract_id = contract.id AND status = 'recorded'
       ) money ON true
       LEFT JOIN LATERAL (
         SELECT sum(advance_offset_amount) AS offsets FROM acceptance_records
         WHERE contract_id = contract.id AND status IN ('draft', 'submitted', 'approved')
       ) pending ON true
       WHERE ${where.join(' AND ')}
       ORDER BY partner.code ASC, contract.contract_number ASC`,
      params,
    )) as Array<Record<string, unknown>>;
    const records = await this.payments.issuedRecords(this.dataSource.manager, {
      contractIds: contracts.map((contract) => contract.id as string),
    });
    const byContract = new Map<string, typeof records>();
    for (const record of records) {
      byContract.set(record.contractId, [...(byContract.get(record.contractId) ?? []), record]);
    }
    const rows: PayableRow[] = contracts.map((contract) => {
      const nullable = (value: unknown) => (value === null ? null : Number(value));
      const ledger = buildLedger({
        contract: {
          status: contract.status as string,
          capAmount: nullable(contract.capAmount),
          advanceAmount: money(contract.advanceAmount),
          penaltyPercent: money(contract.penaltyPercent),
          legacyAcceptedAmount: nullable(contract.legacyAcceptedAmount),
          legacyPaidAmount: nullable(contract.legacyPaidAmount),
          legacyAdvanceBalance: nullable(contract.legacyAdvanceBalance),
        },
        records: byContract.get(contract.id as string) ?? [],
        pendingOffsets: money(contract.pendingOffsets),
        advancesPaid: money(contract.advancesPaid),
        refunds: money(contract.refunds),
        today: asOf,
      });
      return {
        contractId: contract.id as string,
        contractNumber: contract.contractNumber as string,
        contractStatus: contract.status as string,
        partnerId: contract.partnerId as string,
        partnerCode: contract.partnerCode as string,
        partnerName: contract.partnerName as string,
        managerUserId: contract.managerUserId as string,
        acceptedAmount: ledger.acceptedAmount,
        grossAmount: ledger.grossAmount,
        taxAmount: ledger.taxAmount,
        advanceOffsetAmount: ledger.advanceOffsetAmount,
        netPayable: ledger.netPayable,
        settlementsPaid: ledger.settlementsPaid,
        legacyPaidAmount: ledger.legacyPaidAmount,
        advancesPaid: ledger.advancesPaid,
        refunds: ledger.refunds,
        advanceBalance: ledger.advanceBalance,
        outstanding: ledger.outstanding,
        overdueAmount: ledger.overdueAmount,
        overdueCount: ledger.overdueCount,
        capAmount: ledger.capAmount,
        capRatio: ledger.capRatio,
        capAlert: ledger.capAlert,
        refundDue: ledger.refundDue,
      };
    });
    const partners = new Map<
      string,
      SummedPayable & {
        partnerId: string;
        partnerCode: string;
        partnerName: string;
        contracts: number;
      }
    >();
    const totals = emptyTotals();
    for (const row of rows) {
      const partner =
        partners.get(row.partnerId) ??
        partners
          .set(row.partnerId, {
            partnerId: row.partnerId,
            partnerCode: row.partnerCode,
            partnerName: row.partnerName,
            contracts: 0,
            ...emptyTotals(),
          })
          .get(row.partnerId)!;
      partner.contracts += 1;
      addTotals(partner, row);
      addTotals(totals, row);
    }
    return {
      asOf,
      contracts: rows,
      partners: [...partners.values()],
      totals,
      capAlerts: rows.filter((row) => row.capAlert !== 'none'),
    };
  }

  /** Payments recorded in a period, per month and kind (FR-R-01), and the payments themselves. */
  async paymentsByPeriod(query: PaymentReportQueryDto, actor: PartnerActor) {
    const { where, params } = this.paymentFilter(query, actor);
    const items = (await this.dataSource.query(
      `SELECT payment.id, payment.kind, payment.amount::bigint AS amount,
              payment.paid_date::text AS "paidDate", payment.method, payment.reference,
              payment.contract_id AS "contractId", contract.contract_number AS "contractNumber",
              payment.partner_id AS "partnerId", partner.code AS "partnerCode",
              partner.display_name AS "partnerName", payment.acceptance_id AS "acceptanceId",
              record.appendix_number AS "appendixNumber"
       FROM payments payment
       INNER JOIN contracts contract ON contract.id = payment.contract_id
       INNER JOIN partners partner ON partner.id = payment.partner_id
       LEFT JOIN acceptance_records record ON record.id = payment.acceptance_id
       WHERE ${where.join(' AND ')}
       ORDER BY payment.paid_date ASC, payment.created_at ASC`,
      params,
    )) as PaymentReportItem[];
    const periods = new Map<
      string,
      { period: string; advance: number; settlement: number; refund: number; netOut: number }
    >();
    const totals = { advance: 0, settlement: 0, refund: 0, netOut: 0 };
    const rows = items.map((item): PaymentReportItem => {
      const amount = money(item.amount);
      const kind = item.kind;
      const key = item.paidDate.slice(0, 7);
      const period =
        periods.get(key) ??
        periods
          .set(key, { period: key, advance: 0, settlement: 0, refund: 0, netOut: 0 })
          .get(key)!;
      period[kind] += amount;
      totals[kind] += amount;
      const signed = kind === 'refund' ? -amount : amount;
      period.netOut += signed;
      totals.netOut += signed;
      return { ...item, amount };
    });
    return {
      from: query.from ?? null,
      to: query.to ?? null,
      periods: [...periods.values()],
      totals,
      items: rows,
    };
  }

  /** Acceptance records by status in a period (record date, else creation day), and the list. */
  async acceptancesByStatus(query: AcceptanceStatusReportQueryDto, actor: PartnerActor) {
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const manager = this.scopeManager(query.managerUserId, actor);
    if (manager) where.push(`contract.manager_user_id = ${param(manager)}`);
    if (query.partnerId) where.push(`record.partner_id = ${param(query.partnerId)}`);
    if (query.contractId) where.push(`record.contract_id = ${param(query.contractId)}`);
    const day = `COALESCE(record.record_date, (record.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)`;
    if (query.from) where.push(`${day} >= ${param(query.from)}`);
    if (query.to) where.push(`${day} <= ${param(query.to)}`);
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (await this.dataSource.query(
      `SELECT record.id, record.status, record.appendix_number AS "appendixNumber",
              record.period_start::text AS "periodStart", record.period_end::text AS "periodEnd",
              ${day}::text AS "recordDate", record.due_date::text AS "dueDate",
              record.gross_amount::bigint AS "grossAmount", record.tax_amount::bigint AS "taxAmount",
              record.advance_offset_amount::bigint AS "advanceOffsetAmount",
              record.net_payable::bigint AS "netPayable",
              COALESCE(settled.paid, 0)::bigint AS paid,
              record.contract_id AS "contractId", contract.contract_number AS "contractNumber",
              record.partner_id AS "partnerId", partner.code AS "partnerCode",
              partner.display_name AS "partnerName"
       FROM acceptance_records record
       INNER JOIN contracts contract ON contract.id = record.contract_id
       INNER JOIN partners partner ON partner.id = record.partner_id
       LEFT JOIN LATERAL (
         SELECT sum(amount) AS paid FROM payments
         WHERE acceptance_id = record.id AND kind = 'settlement' AND status = 'recorded'
       ) settled ON true
       ${filter}
       ORDER BY ${day} ASC, contract.contract_number ASC, record.appendix_number ASC NULLS LAST`,
      params,
    )) as AcceptanceReportItem[];
    const all = rows.map((row): AcceptanceReportItem => {
      const netPayable = money(row.netPayable);
      const paid = money(row.paid);
      const final = !['draft', 'submitted', 'approved', 'cancelled'].includes(row.status);
      return {
        ...row,
        grossAmount: money(row.grossAmount),
        taxAmount: money(row.taxAmount),
        advanceOffsetAmount: money(row.advanceOffsetAmount),
        netPayable,
        paid,
        remaining: final ? remainingPayable(netPayable, paid) : 0,
      };
    });
    const byStatus = new Map<
      string,
      {
        status: string;
        count: number;
        grossAmount: number;
        taxAmount: number;
        netPayable: number;
        paid: number;
        remaining: number;
      }
    >();
    for (const row of all) {
      const entry =
        byStatus.get(row.status) ??
        byStatus
          .set(row.status, {
            status: row.status,
            count: 0,
            grossAmount: 0,
            taxAmount: 0,
            netPayable: 0,
            paid: 0,
            remaining: 0,
          })
          .get(row.status)!;
      entry.count += 1;
      entry.grossAmount += row.grossAmount;
      entry.taxAmount += row.taxAmount;
      entry.netPayable += row.netPayable;
      entry.paid += row.paid;
      entry.remaining += row.remaining;
    }
    return {
      from: query.from ?? null,
      to: query.to ?? null,
      byStatus: [...byStatus.values()],
      items: query.status ? all.filter((row) => row.status === query.status) : all,
    };
  }

  /** Personal income tax withheld per partner in a year (FR-R-04), issued records by record date. */
  async taxByPartner(query: TaxReportQueryDto, actor: PartnerActor) {
    const where = [
      `record.status IN ('issued', 'signed', 'partially_paid', 'paid')`,
      `record.record_date >= make_date($1, 1, 1)`,
      `record.record_date < make_date($1 + 1, 1, 1)`,
    ];
    const params: unknown[] = [query.year];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const manager = this.scopeManager(undefined, actor);
    if (manager) where.push(`contract.manager_user_id = ${param(manager)}`);
    if (query.partnerId) where.push(`record.partner_id = ${param(query.partnerId)}`);
    const rows = (await this.dataSource.query(
      `SELECT partner.id AS "partnerId", partner.code AS "partnerCode",
              partner.display_name AS "partnerName", count(*)::int AS records,
              sum(record.gross_amount)::bigint AS "grossAmount",
              sum(record.tax_amount)::bigint AS "taxAmount",
              sum(record.net_payable)::bigint AS "netPayable"
       FROM acceptance_records record
       INNER JOIN contracts contract ON contract.id = record.contract_id
       INNER JOIN partners partner ON partner.id = record.partner_id
       WHERE ${where.join(' AND ')}
       GROUP BY partner.id, partner.code, partner.display_name
       ORDER BY partner.code ASC`,
      params,
    )) as Array<Record<string, unknown>>;
    const partners = rows.map((row) => ({
      ...row,
      grossAmount: money(row.grossAmount),
      taxAmount: money(row.taxAmount),
      netPayable: money(row.netPayable),
    })) as Array<
      Record<string, unknown> & { grossAmount: number; taxAmount: number; netPayable: number }
    >;
    return {
      year: query.year,
      partners,
      totals: {
        grossAmount: partners.reduce((sum, row) => sum + row.grossAmount, 0),
        taxAmount: partners.reduce((sum, row) => sum + row.taxAmount, 0),
        netPayable: partners.reduce((sum, row) => sum + row.netPayable, 0),
      },
    };
  }

  /** One report as an Excel file (no personal data beyond the partner name and code); audited. */
  async exportXlsx(query: ReportExportQueryDto, actor: PartnerActor) {
    const asOf = contractDay(new Date());
    const range = `Kỳ: ${query.from ?? '…'} – ${query.to ?? '…'}`;
    let sheets: Array<ExcelSheet<never>>;
    let name: string;
    if (query.report === 'payables') {
      const report = await this.payables(query, actor);
      name = 'cong-no';
      sheets = [
        sheet({
          name: 'Theo hợp đồng',
          title: 'CÔNG NỢ THEO HỢP ĐỒNG',
          subtitle: [`Tính đến ngày ${asOf}`],
          total: true,
          columns: [
            { header: 'Mã đối tác', key: 'partnerCode', width: 12 },
            { header: 'Đối tác', key: 'partnerName', width: 24 },
            { header: 'Số HĐ', key: 'contractNumber', width: 26 },
            { header: 'Trạng thái HĐ', key: 'contractStatus', width: 12 },
            { header: 'Đã nghiệm thu', key: 'acceptedAmount', money: true },
            { header: 'Thuế TNCN', key: 'taxAmount', money: true },
            { header: 'Đối trừ tạm ứng', key: 'advanceOffsetAmount', money: true },
            { header: 'Thực lĩnh', key: 'netPayable', money: true },
            { header: 'Đã chi BBNT', key: 'settlementsPaid', money: true },
            { header: 'Đã chi trước AG Go', key: 'legacyPaidAmount', money: true },
            { header: 'Tạm ứng đã chi', key: 'advancesPaid', money: true },
            { header: 'Đã hoàn tạm ứng', key: 'refunds', money: true },
            { header: 'Số dư tạm ứng', key: 'advanceBalance', money: true },
            { header: 'Còn phải trả', key: 'outstanding', money: true },
            { header: 'Quá hạn', key: 'overdueAmount', money: true },
            { header: 'Trần HĐ', key: 'capAmount', money: true },
            { header: '% trần', key: 'capRatio', width: 10 },
            { header: 'Phải hoàn', key: 'refundDue', money: true },
          ],
          rows: report.contracts,
        }),
        sheet({
          name: 'Theo đối tác',
          title: 'CÔNG NỢ THEO ĐỐI TÁC',
          subtitle: [`Tính đến ngày ${asOf}`],
          total: true,
          columns: [
            { header: 'Mã đối tác', key: 'partnerCode', width: 12 },
            { header: 'Đối tác', key: 'partnerName', width: 24 },
            { header: 'Số HĐ', key: 'contracts', width: 8 },
            { header: 'Đã nghiệm thu', key: 'acceptedAmount', money: true },
            { header: 'Thuế TNCN', key: 'taxAmount', money: true },
            { header: 'Thực lĩnh', key: 'netPayable', money: true },
            { header: 'Đã chi BBNT', key: 'settlementsPaid', money: true },
            { header: 'Tạm ứng đã chi', key: 'advancesPaid', money: true },
            { header: 'Số dư tạm ứng', key: 'advanceBalance', money: true },
            { header: 'Còn phải trả', key: 'outstanding', money: true },
            { header: 'Quá hạn', key: 'overdueAmount', money: true },
          ],
          rows: report.partners,
        }),
      ];
    } else if (query.report === 'payments') {
      const report = await this.paymentsByPeriod(query, actor);
      name = 'thanh-toan';
      sheets = [
        sheet({
          name: 'Theo tháng',
          title: 'THANH TOÁN THEO KỲ',
          subtitle: [range],
          total: true,
          columns: [
            { header: 'Tháng', key: 'period', width: 10 },
            { header: 'Tạm ứng', key: 'advance', money: true },
            { header: 'Thanh toán BBNT', key: 'settlement', money: true },
            { header: 'Hoàn tạm ứng', key: 'refund', money: true },
            { header: 'Chi ròng', key: 'netOut', money: true },
          ],
          rows: report.periods,
        }),
        sheet({
          name: 'Chi tiết',
          title: 'CHI TIẾT THANH TOÁN',
          subtitle: [range],
          total: true,
          columns: [
            { header: 'Ngày', key: 'paidDate', width: 12 },
            { header: 'Loại', key: 'kindLabel', width: 16 },
            { header: 'Mã đối tác', key: 'partnerCode', width: 12 },
            { header: 'Đối tác', key: 'partnerName', width: 24 },
            { header: 'Số HĐ', key: 'contractNumber', width: 26 },
            { header: 'Phụ lục số', key: 'appendixNumber', width: 10 },
            { header: 'Số tiền', key: 'amount', money: true },
            { header: 'Mã giao dịch', key: 'reference', width: 20 },
          ],
          rows: report.items.map((item) => ({
            ...item,
            kindLabel: KIND_LABELS[item.kind] ?? item.kind,
          })),
        }),
      ];
    } else if (query.report === 'acceptances') {
      const report = await this.acceptancesByStatus(query, actor);
      name = 'bbnt-theo-trang-thai';
      sheets = [
        sheet({
          name: 'Theo trạng thái',
          title: 'BBNT THEO TRẠNG THÁI',
          subtitle: [range],
          total: true,
          columns: [
            { header: 'Trạng thái', key: 'label', width: 18 },
            { header: 'Số BBNT', key: 'count', width: 10, money: true },
            { header: 'Giá trị nghiệm thu', key: 'grossAmount', money: true },
            { header: 'Thuế TNCN', key: 'taxAmount', money: true },
            { header: 'Thực lĩnh', key: 'netPayable', money: true },
            { header: 'Đã chi', key: 'paid', money: true },
            { header: 'Còn phải trả', key: 'remaining', money: true },
          ],
          rows: report.byStatus.map((row) => ({
            ...row,
            label: STATUS_LABELS[row.status] ?? row.status,
          })),
        }),
        sheet({
          name: 'Danh sách',
          title: 'DANH SÁCH BBNT',
          subtitle: [range],
          total: true,
          columns: [
            { header: 'Ngày lập', key: 'recordDate', width: 12 },
            { header: 'Trạng thái', key: 'label', width: 16 },
            { header: 'Mã đối tác', key: 'partnerCode', width: 12 },
            { header: 'Đối tác', key: 'partnerName', width: 24 },
            { header: 'Số HĐ', key: 'contractNumber', width: 26 },
            { header: 'Phụ lục số', key: 'appendixNumber', width: 10 },
            { header: 'Giá trị nghiệm thu', key: 'grossAmount', money: true },
            { header: 'Thuế TNCN', key: 'taxAmount', money: true },
            { header: 'Đối trừ tạm ứng', key: 'advanceOffsetAmount', money: true },
            { header: 'Thực lĩnh', key: 'netPayable', money: true },
            { header: 'Đã chi', key: 'paid', money: true },
            { header: 'Còn phải trả', key: 'remaining', money: true },
            { header: 'Hạn thanh toán', key: 'dueDate', width: 14 },
          ],
          rows: report.items.map((row) => ({
            ...row,
            label: STATUS_LABELS[row.status] ?? row.status,
          })),
        }),
      ];
    } else {
      if (!query.year) {
        throw new BadRequestException({
          code: 'PAYMENT_REPORT_YEAR_REQUIRED',
          message: 'year is required for the tax report',
        });
      }
      const report = await this.taxByPartner(
        { year: query.year, partnerId: query.partnerId },
        actor,
      );
      name = `thue-tncn-${query.year}`;
      sheets = [
        sheet({
          name: `Thuế TNCN ${query.year}`,
          title: `THUẾ TNCN ĐÃ KHẤU TRỪ NĂM ${query.year}`,
          subtitle: [`Ngày xuất: ${asOf}`],
          total: true,
          columns: [
            { header: 'Mã đối tác', key: 'partnerCode', width: 12 },
            { header: 'Đối tác', key: 'partnerName', width: 26 },
            { header: 'Số BBNT', key: 'records', width: 10, money: true },
            { header: 'Tổng thu nhập', key: 'grossAmount', money: true },
            { header: 'Thuế đã khấu trừ', key: 'taxAmount', money: true },
            { header: 'Thực lĩnh', key: 'netPayable', money: true },
          ],
          rows: report.partners,
        }),
      ];
    }
    const buffer = await buildWorkbook(sheets);
    await this.systemLog.write({
      level: 'info',
      category: PAYMENT_AUDIT_CATEGORY,
      action: 'PAYMENT_REPORT_EXPORTED',
      message: `PAYMENT_REPORT_EXPORTED ${query.report}`,
      requestId: actor.requestId ?? null,
      userId: actor.userId,
      metadata: { report: query.report, filters: { ...query } },
    });
    return { buffer, fileName: `bao-cao-${name}-${asOf}.xlsx`, contentType: XLSX };
  }

  // -------------------------------------------------------------------------

  /** Manager to scope on: the one asked for, or oneself without go.contract.read_all. */
  private scopeManager(requested: string | undefined, actor: PartnerActor): string | undefined {
    if (!hasPermission(actor, GO_PERMISSIONS.CONTRACT_READ_ALL)) {
      return actor.userId;
    }
    return requested;
  }

  private paymentFilter(query: PaymentReportQueryDto, actor: PartnerActor) {
    const where = [`payment.status = 'recorded'`];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const manager = this.scopeManager(query.managerUserId, actor);
    if (manager) where.push(`contract.manager_user_id = ${param(manager)}`);
    if (query.partnerId) where.push(`payment.partner_id = ${param(query.partnerId)}`);
    if (query.contractId) where.push(`payment.contract_id = ${param(query.contractId)}`);
    if (query.from) where.push(`payment.paid_date >= ${param(query.from)}`);
    if (query.to) where.push(`payment.paid_date <= ${param(query.to)}`);
    return { where, params };
  }
}
