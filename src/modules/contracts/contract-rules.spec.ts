import { parseImportDate, parseLegacyContractRow } from './contract-import';
import { contractNumberBase, nextAppendixNumber, nextContractNumber } from './contract-number';
import {
  allowedContractActions,
  amendable,
  canTransition,
  ContractTransitionError,
  nextContractStatus,
  termsEditable,
} from './contract-state';
import {
  effectiveTerms,
  TECH_SPEC_PRESETS,
  validateContractTerms,
  type ContractTerms,
} from './contract-terms';

const CATEGORY = '0190f000-0000-7000-8000-000000000001';

describe('contract state machine (spec 5.2)', () => {
  it('follows the allowed transitions', () => {
    expect(nextContractStatus('draft', 'issue')).toBe('issued');
    expect(nextContractStatus('issued', 'unissue')).toBe('draft');
    expect(nextContractStatus('issued', 'activate')).toBe('active');
    expect(nextContractStatus('active', 'suspend')).toBe('suspended');
    expect(nextContractStatus('suspended', 'resume')).toBe('active');
    expect(nextContractStatus('active', 'complete')).toBe('completed');
    expect(nextContractStatus('active', 'terminate')).toBe('terminated');
    expect(nextContractStatus('suspended', 'terminate')).toBe('terminated');
  });

  it('refuses the others', () => {
    expect(() => nextContractStatus('draft', 'activate')).toThrow(ContractTransitionError);
    expect(() => nextContractStatus('suspended', 'complete')).toThrow(ContractTransitionError);
    expect(() => nextContractStatus('active', 'issue')).toThrow(
      'Cannot issue a contract in status active',
    );
    for (const action of ['issue', 'activate', 'resume', 'terminate', 'complete'] as const) {
      expect(canTransition('completed', action)).toBe(false);
      expect(canTransition('terminated', action)).toBe(false);
    }
  });

  it('lists the actions of each status', () => {
    expect(allowedContractActions('draft')).toEqual(['issue']);
    expect(allowedContractActions('issued')).toEqual(['unissue', 'activate']);
    expect(allowedContractActions('active')).toEqual(['suspend', 'complete', 'terminate']);
    expect(allowedContractActions('suspended')).toEqual(['resume', 'terminate']);
    expect(allowedContractActions('terminated')).toEqual([]);
  });

  it('edits terms only in draft and amends only running contracts', () => {
    expect(termsEditable('draft')).toBe(true);
    expect(termsEditable('issued')).toBe(false);
    expect(termsEditable('active')).toBe(false);
    expect(amendable('active')).toBe(true);
    expect(amendable('suspended')).toBe(true);
    expect(amendable('draft')).toBe(false);
    expect(amendable('completed')).toBe(false);
  });
});

describe('contract number (BR-05, BR-07)', () => {
  it('formats DDMMYY/HĐSXND/AG-<code> from the signing date', () => {
    expect(contractNumberBase('2026-08-01', 'NHH')).toBe('010826/HĐSXND/AG-NHH');
    expect(contractNumberBase('2026-06-22', 'NTXN')).toBe('220626/HĐSXND/AG-NTXN');
    expect(() => contractNumberBase('01/08/2026', 'NHH')).toThrow();
  });

  it('adds -2, -3 when the number is taken', () => {
    const base = '010826/HĐSXND/AG-NHH';
    expect(nextContractNumber(base, [])).toBe(base);
    expect(nextContractNumber(base, [base])).toBe(`${base}-2`);
    expect(nextContractNumber(base, [base, `${base}-2`])).toBe(`${base}-3`);
    expect(nextContractNumber(base, [`${base}-2`])).toBe(base);
  });

  it('continues appendix numbers of imported contracts', () => {
    expect(nextAppendixNumber(0)).toBe(1);
    expect(nextAppendixNumber(4)).toBe(5);
  });
});

describe('contract terms (FR-C-01, FR-C-04)', () => {
  const techSpec = TECH_SPEC_PRESETS.footage_4k60.techSpec;

  it('accepts each pricing model with its schema and applies defaults', () => {
    const topic = validateContractTerms({
      pricingModel: 'per_topic',
      pricingConfig: { unit_price: 2_500_000, min_topic_minutes: 20, max_topic_minutes: 60 },
      techSpec,
    });
    expect(topic).toMatchObject({
      ok: true,
      value: { pricingConfig: { unit_price: 2_500_000, require_audio: true } },
    });

    expect(
      validateContractTerms({
        pricingModel: 'per_unit',
        pricingConfig: { unit: 'clip', unit_price: 300_000, max_shots_per_clip: 5 },
        techSpec,
      }).ok,
    ).toBe(true);

    expect(
      validateContractTerms({
        pricingModel: 'package_tier',
        pricingConfig: { rate_card_id: 'CTV-2026', level: 'LV1', category_ids: [CATEGORY] },
        techSpec,
        deliveryRule: { type: 'monthly_before_day', day: 15 },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        pricingConfig: { employment_stage: 'official' },
        deliveryRule: { type: 'monthly_before_day', day: 15 },
      },
    });
  });

  it('refuses a config of another model, unknown keys and missing clip size', () => {
    const wrongModel = validateContractTerms({
      pricingModel: 'per_unit',
      pricingConfig: { unit_price: 2_500_000, min_topic_minutes: 20 },
      techSpec,
    });
    expect(wrongModel.ok).toBe(false);
    expect(!wrongModel.ok && wrongModel.errors.pricingConfig?.length).toBeGreaterThan(0);

    const clip = validateContractTerms({
      pricingModel: 'per_unit',
      pricingConfig: { unit: 'clip', unit_price: 300_000 },
      techSpec,
    });
    expect(!clip.ok && clip.errors.pricingConfig?.join()).toContain('max_shots_per_clip');

    const tier = validateContractTerms({
      pricingModel: 'package_tier',
      pricingConfig: { rate_card_id: 'CTV', level: 'LV4', category_ids: [] },
      techSpec,
    });
    expect(tier.ok).toBe(false);

    expect(
      validateContractTerms({
        pricingModel: 'per_topic',
        pricingConfig: { unit_price: 1, min_topic_minutes: 20, max_topic_minutes: 10 },
        techSpec,
      }).ok,
    ).toBe(false);
  });

  it('checks the tech spec, delivery rule, advance and dates', () => {
    const result = validateContractTerms({
      pricingModel: 'per_topic',
      pricingConfig: { unit_price: 1, min_topic_minutes: 20 },
      techSpec: { min_width: -1, unknown_rule: true },
      deliveryRule: { type: 'monthly_before_day', day: 40 },
      capAmount: 1_000,
      advanceAmount: 2_000,
      startDate: '2026-08-01',
      endDate: '2026-07-01',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual([
      'advanceAmount',
      'advanceDueBusinessDays',
      'deliveryRule',
      'endDate',
      'techSpec',
    ]);
  });
});

describe('effective terms (spec 7.3)', () => {
  const base: ContractTerms = {
    pricing_model: 'per_unit',
    pricing_config: { unit: 'shot', unit_price: 300_000 },
    cap_amount: 50_000_000,
    tech_spec: { min_width: 3840 },
    end_date: null,
    payment_term_business_days: 10,
    penalty_percent: 8,
  };

  it('applies signed amendments effective on the day, in number order', () => {
    const amendments = [
      {
        amendmentNumber: 2,
        effectiveDate: '2026-10-01',
        status: 'signed',
        changes: { cap_amount: 90_000_000 },
      },
      {
        amendmentNumber: 1,
        effectiveDate: '2026-09-01',
        status: 'signed',
        changes: { cap_amount: 70_000_000, tech_spec: { min_width: 1920 } },
      },
      {
        amendmentNumber: 3,
        effectiveDate: '2026-09-01',
        status: 'issued',
        changes: { cap_amount: 1 },
      },
    ];

    expect(effectiveTerms(base, amendments, '2026-08-31')).toMatchObject({
      cap_amount: 50_000_000,
      appliedAmendments: [],
    });
    expect(effectiveTerms(base, amendments, '2026-09-15')).toMatchObject({
      cap_amount: 70_000_000,
      tech_spec: { min_width: 1920 },
      appliedAmendments: [1],
    });
    expect(effectiveTerms(base, amendments, '2026-10-01')).toMatchObject({
      cap_amount: 90_000_000,
      tech_spec: { min_width: 1920 },
      appliedAmendments: [1, 2],
    });
  });
});

describe('legacy contract import (FR-C-11)', () => {
  const values = {
    partner_code: 'nbn',
    contract_number: '060626/AG-NBN',
    signed_date: '06/06/2026',
    start_date: '2026-06-06',
    end_date: '',
    status: 'Active',
    pricing_model: 'per_unit',
    pricing_config: '{"unit":"shot","unit_price":300000}',
    acceptance_cycle: 'monthly',
    payment_term_business_days: '10',
    cap_amount: '72.500.000',
    advance_amount: '0',
    advance_due_business_days: '',
    last_appendix_number: '4',
    legacy_accepted_amount: '15000000',
    legacy_paid_amount: '',
    legacy_advance_balance: '',
    note: '',
  };

  it('parses dates, numbers and keeps the old number', () => {
    const result = parseLegacyContractRow(2, values);
    expect(result.errors).toEqual([]);
    expect(result.value).toMatchObject({
      partnerCode: 'NBN',
      contractNumber: '060626/AG-NBN',
      signedDate: '2026-06-06',
      endDate: null,
      status: 'active',
      pricingConfig: { unit: 'shot', unit_price: 300000 },
      capAmount: 72_500_000,
      lastAppendixNumber: 4,
      legacyAcceptedAmount: 15_000_000,
      legacyPaidAmount: null,
    });
  });

  it('reports each invalid cell', () => {
    const result = parseLegacyContractRow(3, {
      ...values,
      signed_date: '31/02/2026',
      status: 'draft',
      pricing_config: '{oops',
      payment_term_business_days: '',
      cap_amount: '-5',
    });
    expect(result.value).toBeNull();
    expect(result.errors.map((error) => error.field).sort()).toEqual([
      'cap_amount',
      'payment_term_business_days',
      'pricing_config',
      'signed_date',
      'status',
    ]);
    expect(result.errors.every((error) => error.row === 3)).toBe(true);
  });

  it('reads both date formats and refuses impossible dates', () => {
    expect(parseImportDate('1/8/2026')).toBe('2026-08-01');
    expect(parseImportDate('2026-08-01')).toBe('2026-08-01');
    expect(parseImportDate('2026-02-30')).toBeNull();
    expect(parseImportDate('0709')).toBeNull();
  });
});
