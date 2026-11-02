import type { PricingModel } from '../../database/entities/contract.entity';
import { PRICING_MODELS } from '../../database/entities/contract.entity';
import type { DocumentKind, RenderInput } from './render-data';

/**
 * Fictitious data covering every placeholder of each document kind and pricing model: the
 * placeholder catalog is read from it (so it cannot drift from the builder) and the UI shows its
 * values as examples. Numbers follow the real records of spec 6.8 (D2, D4, D6).
 */

const COMPANY = {
  name: 'CÔNG TY CỔ PHẦN ANT GROUP',
  taxCode: '0100000000',
  representative: 'Ông Nguyễn Văn A',
  title: 'Giám đốc',
  address: 'Số 1 Phố Mẫu, Phường Mẫu, Hà Nội',
  phone: '024 0000 0000',
  email: 'contact@example.com',
  bankAccountNumber: '0000000000',
  bankName: 'Ngân hàng Mẫu',
};

const PARTNER = {
  name: 'Nguyễn Văn B',
  partnerCode: 'NVB',
  email: 'partner@example.com',
  fields: {
    birthday: '1990-01-02',
    citizenIdNumber: '001090000000',
    idIssuedDate: '2021-05-06',
    idIssuedPlace: 'Cục Cảnh sát QLHC về TTXH',
    address: 'Số 2 Đường Mẫu, Hà Nội',
    permanentAddress: 'Số 3 Đường Mẫu, Nam Định',
    phoneNumber: '0900000000',
    taxNumber: '8000000000',
    bankAccountName: 'NGUYEN VAN B',
    bankAccountNumber: '1234567890',
    bankName: 'Ngân hàng Mẫu',
    taxMode: 'WITHHOLD_10',
  },
};

const TECH_SPEC = {
  min_width: 3840,
  min_height: 2160,
  fps: { target: 60, tolerance: 0.1 },
  source_duration_rule: { min_seconds: 10, preferred_seconds: 20, preferred_ratio: 0.8 },
  per_source_min_seconds: 300,
  min_shot_seconds: 60,
  min_shots_per_scene: 5,
  min_topic_minutes: 20,
  require_audio: true,
  reject_dead: true,
  uniform_within_project: true,
};

const PRICING_CONFIGS: Record<PricingModel, Record<string, unknown>> = {
  per_topic: {
    unit_price: 2_500_000,
    min_topic_minutes: 20,
    max_topic_minutes: 60,
    topics: ['Du lịch', 'Văn hoá', 'Ẩm thực'],
    require_audio: true,
  },
  per_unit: { unit: 'clip', unit_price: 300_000, max_shots_per_clip: 5, min_shot_seconds: 60 },
  package_tier: {
    rate_card_id: 'CTV-2026',
    level: 'LV1',
    category_ids: ['00000000-0000-0000-0000-000000000001'],
    employment_stage: 'official',
  },
};

export function sampleRenderInput(kind: DocumentKind, model: PricingModel): RenderInput {
  const pricingConfig = PRICING_CONFIGS[model];
  return {
    kind,
    documentDate: '2026-10-07',
    draft: false,
    company: COMPANY,
    partner: PARTNER,
    contract: {
      contractNumber: '070926/HĐSXND/AG-NVB',
      signedDate: '2026-09-07',
      startDate: '2026-09-07',
      endDate: '2027-09-06',
      pricingModel: model,
      pricingConfig,
      capAmount: 100_000_000,
      advanceAmount: 50_000_000,
      advanceDueBusinessDays: 5,
      acceptanceCycle: 'monthly',
      deliveryRule: { type: 'monthly_before_day', day: 15 },
      paymentTermBusinessDays: 30,
      techSpec: TECH_SPEC,
      penaltyPercent: 8,
      originalityMinPercent: 70,
      similarityMaxPercent: 30,
      nonCompeteMonths: 24,
    },
    pricingConfig,
    techSpec: TECH_SPEC,
    rateCard: {
      code: 'CTV-2026',
      version: 2,
      effectiveFrom: '2026-07-15',
      prices: [
        {
          product: 'CẢNH',
          pricingType: 'tier',
          tier: 3,
          sourceMin: 150,
          sourceMax: 200,
          sceneMin: 14,
          price: 1_300_000,
          minSourceSeconds: null,
        },
        {
          product: 'Lái xe',
          pricingType: 'per_source',
          tier: null,
          sourceMin: null,
          sourceMax: null,
          sceneMin: null,
          price: 50_000,
          minSourceSeconds: 300,
        },
      ],
      extraScenePrice: 80_000,
      extraSceneMinSources: 8,
    },
    productNames: ['CẢNH'],
    amendment: {
      amendmentNumber: 1,
      effectiveDate: '2026-11-01',
      reason: 'Điều chỉnh đơn giá',
      changes: { pricing_config: pricingConfig, cap_amount: 150_000_000 },
    },
    acceptance: {
      appendixNumber: 2,
      recordDate: '2026-10-07',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      deliveryMethod: 'ag_go',
      deliveryNote: 'Đã bàn giao đủ',
      grossAmount: 72_500_000,
      taxRate: 10,
      taxAmount: 7_250_000,
      advanceOffsetAmount: 0,
      netPayable: 65_250_000,
      netPayableWords: null,
      items: [
        {
          lineNo: 1,
          productLabel: 'VIDEO TRẢI NGHIỆM',
          unit: 'package',
          quantity: 1,
          unitPrice: 72_500_000,
          amount: 72_500_000,
          metrics: { sources: 158, scenes: 14, tier: 3 },
        },
      ],
    },
  };
}

/** Sample inputs of every pricing model for one kind (the union of their placeholders). */
export function sampleRenderInputs(kind: DocumentKind): RenderInput[] {
  return PRICING_MODELS.map((model) => sampleRenderInput(kind, model));
}
