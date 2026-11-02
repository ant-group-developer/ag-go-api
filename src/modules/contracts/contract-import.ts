import type { CsvImportError } from '../../common/csv/csv-import';
import { toErrorValue } from '../../common/csv/csv-import';
import {
  ACCEPTANCE_CYCLES,
  PRICING_MODELS,
  type AcceptanceCycle,
  type ContractStatus,
  type PricingModel,
} from '../../database/entities/contract.entity';

/**
 * Columns of the legacy contract import (FR-C-11, spec 15.2). Contracts signed outside AG Go keep
 * their number; `last_appendix_number` is the last acceptance appendix already used, so the next
 * one continues from it. `pricing_config` is the JSON of the pricing model (spec 7.2).
 */
export const LEGACY_CONTRACT_HEADERS = [
  'partner_code',
  'contract_number',
  'signed_date',
  'start_date',
  'end_date',
  'status',
  'pricing_model',
  'pricing_config',
  'acceptance_cycle',
  'payment_term_business_days',
  'cap_amount',
  'advance_amount',
  'advance_due_business_days',
  'last_appendix_number',
  'legacy_accepted_amount',
  'legacy_paid_amount',
  'legacy_advance_balance',
  'note',
] as const;

/** Imported contracts are already signed. */
export const LEGACY_CONTRACT_STATUSES = ['active', 'suspended', 'completed', 'terminated'] as const;

export type LegacyContractRow = {
  row: number;
  partnerCode: string;
  contractNumber: string;
  signedDate: string;
  startDate: string;
  endDate: string | null;
  status: ContractStatus;
  pricingModel: PricingModel;
  pricingConfig: unknown;
  acceptanceCycle: AcceptanceCycle;
  paymentTermBusinessDays: number;
  capAmount: number | null;
  advanceAmount: number;
  advanceDueBusinessDays: number | null;
  lastAppendixNumber: number;
  legacyAcceptedAmount: number | null;
  legacyPaidAmount: number | null;
  legacyAdvanceBalance: number | null;
  note: string | null;
};

/** `dd/MM/yyyy` or `yyyy-MM-dd` → `yyyy-MM-dd`; null when not a real date. */
export function parseImportDate(value: string): string | null {
  const text = value.trim();
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) {
    [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) {
      return null;
    }
    [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parses one CSV row (values by header) into a legacy contract, or returns its errors. Checks
 * formats only; partner, uniqueness and pricing schema are checked by the service.
 */
export function parseLegacyContractRow(
  row: number,
  values: Record<string, string>,
): { value: LegacyContractRow; errors: [] } | { value: null; errors: CsvImportError[] } {
  const errors: CsvImportError[] = [];
  const fail = (field: string, reason: string) =>
    errors.push({ row, field, value: toErrorValue(values[field] ?? ''), reason });

  const required = (field: string) => {
    const value = (values[field] ?? '').trim();
    if (!value) {
      fail(field, 'Bắt buộc nhập.');
    }
    return value;
  };
  const date = (field: string, mandatory: boolean) => {
    const value = (values[field] ?? '').trim();
    if (!value) {
      if (mandatory) {
        fail(field, 'Bắt buộc nhập.');
      }
      return null;
    }
    const parsed = parseImportDate(value);
    if (!parsed) {
      fail(field, 'Ngày phải có dạng dd/MM/yyyy hoặc yyyy-MM-dd.');
    }
    return parsed;
  };
  const integer = (field: string, mandatory: boolean, max = 1e15) => {
    const value = (values[field] ?? '').trim().replace(/[.,\s](?=\d{3}(\D|$))/g, '');
    if (!value) {
      if (mandatory) {
        fail(field, 'Bắt buộc nhập.');
      }
      return null;
    }
    if (!/^\d+$/.test(value) || Number(value) > max) {
      fail(field, 'Phải là số nguyên không âm.');
      return null;
    }
    return Number(value);
  };

  const partnerCode = required('partner_code').toUpperCase();
  const contractNumber = required('contract_number');
  if (contractNumber.length > 60) {
    fail('contract_number', 'Tối đa 60 ký tự.');
  }
  const signedDate = date('signed_date', true);
  const startDate = date('start_date', true);
  const endDate = date('end_date', false);
  if (startDate && endDate && endDate < startDate) {
    fail('end_date', 'Ngày kết thúc trước ngày bắt đầu.');
  }

  const status = required('status').toLowerCase();
  if (status && !(LEGACY_CONTRACT_STATUSES as readonly string[]).includes(status)) {
    fail('status', `Chỉ nhận: ${LEGACY_CONTRACT_STATUSES.join(', ')}.`);
  }
  const pricingModel = required('pricing_model').toLowerCase();
  if (pricingModel && !(PRICING_MODELS as readonly string[]).includes(pricingModel)) {
    fail('pricing_model', `Chỉ nhận: ${PRICING_MODELS.join(', ')}.`);
  }
  let pricingConfig: unknown = null;
  const rawConfig = required('pricing_config');
  if (rawConfig) {
    try {
      pricingConfig = JSON.parse(rawConfig) as unknown;
    } catch {
      fail('pricing_config', 'Phải là JSON hợp lệ.');
    }
  }
  const acceptanceCycle = required('acceptance_cycle').toLowerCase();
  if (acceptanceCycle && !(ACCEPTANCE_CYCLES as readonly string[]).includes(acceptanceCycle)) {
    fail('acceptance_cycle', `Chỉ nhận: ${ACCEPTANCE_CYCLES.join(', ')}.`);
  }
  const paymentTerm = integer('payment_term_business_days', true, 365);
  const capAmount = integer('cap_amount', false);
  const advanceAmount = integer('advance_amount', false) ?? 0;
  const advanceDue = integer('advance_due_business_days', false, 365);
  const lastAppendix = integer('last_appendix_number', false, 100_000) ?? 0;
  const accepted = integer('legacy_accepted_amount', false);
  const paid = integer('legacy_paid_amount', false);
  const advanceBalance = integer('legacy_advance_balance', false);
  const note = (values['note'] ?? '').trim();

  if (errors.length > 0) {
    return { value: null, errors };
  }
  return {
    value: {
      row,
      partnerCode,
      contractNumber,
      signedDate: signedDate!,
      startDate: startDate!,
      endDate,
      status: status as ContractStatus,
      pricingModel: pricingModel as PricingModel,
      pricingConfig,
      acceptanceCycle: acceptanceCycle as AcceptanceCycle,
      paymentTermBusinessDays: paymentTerm!,
      capAmount,
      advanceAmount,
      advanceDueBusinessDays: advanceDue,
      lastAppendixNumber: lastAppendix,
      legacyAcceptedAmount: accepted,
      legacyPaidAmount: paid,
      legacyAdvanceBalance: advanceBalance,
      note: note || null,
    },
    errors: [],
  };
}
