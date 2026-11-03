import type { AcceptanceUnit, DeliveryMethod } from '../../database/entities/acceptance.entity';
import type { PricingModel } from '../../database/entities/contract.entity';
import { acceptanceMoneyWords, vietnameseMoneyWords } from '../pricing-engine/money-words';
import { formatDate, formatLongDate, formatMoney, formatNumber } from './document-format';

/**
 * Data the DOCX templates are filled with (spec 13, Phụ lục A): `company.*`, `partner.*`,
 * `contract.*`, `pricing.*`, `tech_spec.*`, `amendment.*`, `acceptance.*`, `items[]`, plus AG Music's
 * names for the totals (`total_acceptance_value`, `personal_income_tax`,
 * `actual_amount_received_number` / `_string`) so business keeps one set of conventions.
 *
 * Pure functions over snapshots: issue and the worker build the same data from the same snapshots.
 * A value that does not apply is printed as `—`; an empty string means the data is missing, which
 * issue refuses (FR-D-03, `missingValues`).
 */

export const DOCUMENT_KINDS = ['contract', 'amendment', 'acceptance'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const NOT_APPLICABLE = '—';

/** Party A (spec FR-D-05), from the `company` system setting, captured when a document is issued. */
export type CompanySnapshot = {
  name: string;
  taxCode: string;
  representative: string;
  title: string;
  address: string;
  phone?: string | null;
  email?: string | null;
  bankAccountNumber?: string | null;
  bankName?: string | null;
  capturedAt?: string;
};

/** Decrypted partner snapshot (contracts.service `PartnerSnapshot`): AG Account profile fields. */
export type PartnerSnapshotData = {
  name: string;
  partnerCode?: string;
  email?: string | null;
  fields: Record<string, string | null | undefined>;
};

export type ContractFacts = {
  contractNumber: string;
  signedDate: string | null;
  startDate: string;
  endDate: string | null;
  pricingModel: PricingModel;
  pricingConfig: Record<string, unknown>;
  capAmount: number | null;
  advanceAmount: number;
  advanceDueBusinessDays: number | null;
  acceptanceCycle: string;
  deliveryRule: Record<string, unknown> | null;
  paymentTermBusinessDays: number;
  techSpec: Record<string, unknown>;
  penaltyPercent: number;
  originalityMinPercent: number | null;
  similarityMaxPercent: number | null;
  nonCompeteMonths: number | null;
};

export type RateCardPrice = {
  product: string;
  pricingType: 'tier' | 'per_source';
  tier: number | null;
  sourceMin: number | null;
  sourceMax: number | null;
  sceneMin: number | null;
  price: number;
  minSourceSeconds: number | null;
};

/** Rate card version printed on a `package_tier` contract (its prices for the contract's level). */
export type RateCardFacts = {
  code: string;
  version: number;
  effectiveFrom: string;
  prices: RateCardPrice[];
  extraScenePrice: number | null;
  extraSceneMinSources: number | null;
};

export type AmendmentFacts = {
  amendmentNumber: number;
  effectiveDate: string;
  reason: string | null;
  /** New values by column (`pricing_config`, `cap_amount`, `tech_spec`…). */
  changes: Record<string, unknown>;
};

export type AcceptanceItemFacts = {
  lineNo: number;
  productLabel: string;
  unit: AcceptanceUnit;
  quantity: number;
  unitPrice: number;
  amount: number;
  metrics: Record<string, unknown>;
};

export type AcceptanceFacts = {
  appendixNumber: number | null;
  recordDate: string | null;
  periodStart: string;
  periodEnd: string;
  deliveryMethod: DeliveryMethod;
  deliveryNote: string | null;
  grossAmount: number;
  taxRate: number;
  taxAmount: number;
  advanceOffsetAmount: number;
  netPayable: number;
  netPayableWords: string | null;
  items: AcceptanceItemFacts[];
};

export type RenderInput = {
  kind: DocumentKind;
  /** Day the document is made (YYYY-MM-DD), printed when no other date applies. */
  documentDate: string;
  /** Preview of data not issued yet. */
  draft: boolean;
  company: CompanySnapshot | null;
  partner: PartnerSnapshotData | null;
  contract: ContractFacts;
  /** Pricing and tech spec in force (acceptance: its terms snapshot; contract: its own terms). */
  pricingConfig: Record<string, unknown>;
  techSpec: Record<string, unknown>;
  rateCard: RateCardFacts | null;
  /** Names of the products (categories) a `package_tier` contract may deliver. */
  productNames: string[];
  amendment?: AmendmentFacts | null;
  acceptance?: AcceptanceFacts | null;
};

export type RenderData = Record<string, unknown>;

const PRICING_MODEL_TEXT: Record<PricingModel, string> = {
  per_topic: 'Theo chủ đề',
  per_unit: 'Theo shot / clip',
  package_tier: 'Theo gói sản phẩm (bảng giá CTV)',
};

const UNIT_LABELS: Record<AcceptanceUnit, string> = {
  topic: 'chủ đề',
  shot: 'shot',
  clip: 'clip',
  package: 'gói',
  extra_scene: 'bối cảnh phát sinh',
  source: 'source',
};

const DELIVERY_METHOD_TEXT: Record<DeliveryMethod, string> = {
  ag_go: 'Bàn giao trên hệ thống AG Go',
  hard_drive: 'Bàn giao bằng ổ cứng',
  google_drive: 'Bàn giao qua Google Drive',
  other: 'Hình thức khác',
};

const ACCEPTANCE_CYCLE_TEXT: Record<string, string> = {
  on_demand: 'khi có sản phẩm hoàn thành',
  weekly: 'hằng tuần',
  monthly: 'hằng tháng',
};

const EMPLOYMENT_STAGE_TEXT: Record<string, string> = {
  probation: 'Thử việc',
  apprentice: 'Học việc',
  official: 'Chính thức',
};

const TAX_MODE_TEXT: Record<string, string> = {
  WITHHOLD_10: 'Bên A khấu trừ 10% thuế TNCN trước khi thanh toán',
  SELF_DECLARE: 'Bên B tự kê khai, quyết toán thuế TNCN',
  BUSINESS_HOUSEHOLD: 'Hộ kinh doanh, Bên B tự kê khai nộp thuế',
};

function text(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A number printed, or `—` when the term is not set. */
function optionalNumber(value: unknown): string {
  const number = num(value);
  return number === null ? NOT_APPLICABLE : formatNumber(number);
}

function words(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : vietnameseMoneyWords(value, 'đồng');
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export function companyData(company: CompanySnapshot | null): RenderData {
  return {
    name: text(company?.name),
    tax_code: text(company?.taxCode),
    representative: text(company?.representative),
    title: text(company?.title),
    address: text(company?.address),
    phone: text(company?.phone),
    email: text(company?.email),
    bank_account_number: text(company?.bankAccountNumber),
    bank_name: text(company?.bankName),
  };
}

export function partnerData(partner: PartnerSnapshotData | null): RenderData {
  const fields = partner?.fields ?? {};
  const field = (key: string) => text(fields[key]);
  const permanentAddress = field('permanentAddress');
  const taxMode = field('taxMode');
  return {
    full_name: text(partner?.name),
    code: text(partner?.partnerCode),
    dob: formatDate(field('birthday')),
    id_number: field('citizenIdNumber'),
    id_issued_date: formatDate(field('idIssuedDate')),
    id_issued_place: field('idIssuedPlace'),
    address: field('address') || permanentAddress,
    permanent_address: permanentAddress,
    phone: field('phoneNumber'),
    email: text(partner?.email),
    tax_code: field('taxNumber'),
    bank_account_name: field('bankAccountName'),
    bank_account_number: field('bankAccountNumber'),
    bank_name: field('bankName') || field('bankCode'),
    tax_mode: taxMode,
    tax_mode_text: TAX_MODE_TEXT[taxMode] ?? taxMode,
  };
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export function deliveryRuleText(
  rule: Record<string, unknown> | null,
  acceptanceCycle: string,
): string {
  if (rule?.type === 'monthly_before_day' && num(rule.day) !== null) {
    return `Bên B bàn giao sản phẩm trước ngày ${String(rule.day).padStart(2, '0')} hằng tháng`;
  }
  if (rule?.type === 'flexible') {
    return 'Bên B bàn giao sản phẩm linh hoạt theo tiến độ thực hiện';
  }
  return `Bên B bàn giao sản phẩm ${ACCEPTANCE_CYCLE_TEXT[acceptanceCycle] ?? acceptanceCycle}`;
}

function resolutionShort(width: number | null, height: number | null): string {
  if (width === null || height === null) {
    return NOT_APPLICABLE;
  }
  if (width >= 3840 && height >= 2160) {
    return '4K';
  }
  if (width >= 2560 && height >= 1440) {
    return '2K';
  }
  if (width >= 1920 && height >= 1080) {
    return 'Full HD';
  }
  return `${width}×${height}`;
}

/** Requirements of the tech spec (spec 8.1) as sentences (Phụ lục B.3: generated, not copied). */
export function techSpecData(spec: Record<string, unknown>): RenderData {
  const width = num(spec.min_width);
  const height = num(spec.min_height);
  const fps = spec.fps as { target?: unknown; tolerance?: unknown } | null | undefined;
  const fpsTarget = num(fps?.target);
  const rule = spec.source_duration_rule as
    | { min_seconds?: unknown; preferred_seconds?: unknown; preferred_ratio?: unknown }
    | null
    | undefined;
  const lines: string[] = [];
  const short = resolutionShort(width, height);
  const resolutionText =
    width !== null && height !== null
      ? `${short === `${width}×${height}` ? '' : `${short} `}(${width}×${height})`.trim()
      : NOT_APPLICABLE;
  if (width !== null && height !== null) {
    lines.push(`Độ phân giải tối thiểu ${resolutionText}`);
  }
  const fpsText =
    fpsTarget === null
      ? NOT_APPLICABLE
      : `${formatNumber(fpsTarget)} fps${num(fps?.tolerance) ? ` (sai lệch ±${formatNumber(num(fps?.tolerance))})` : ''}`;
  if (fpsTarget !== null) {
    lines.push(`Tốc độ khung hình ${fpsText}`);
  }
  let durationRuleText = NOT_APPLICABLE;
  if (rule && num(rule.preferred_ratio) !== null) {
    const ratio = Math.round((num(rule.preferred_ratio) ?? 0) * 100);
    durationRuleText = `${ratio}% số source dài từ ${formatNumber(num(rule.preferred_seconds))} giây, ${100 - ratio}% còn lại dài từ ${formatNumber(num(rule.min_seconds))} giây; source dưới ${formatNumber(num(rule.min_seconds))} giây không được tính`;
    lines.push(durationRuleText);
  }
  if (num(spec.min_shot_seconds) !== null) {
    lines.push(`Mỗi shot dài tối thiểu ${formatNumber(num(spec.min_shot_seconds))} giây`);
  }
  if (num(spec.per_source_min_seconds) !== null) {
    lines.push(
      `Source tính giá theo từng source (Lái xe, Flycam) dài tối thiểu ${formatNumber(num(spec.per_source_min_seconds))} giây`,
    );
  }
  if (num(spec.min_shots_per_scene) !== null) {
    lines.push(`Mỗi bối cảnh có tối thiểu ${formatNumber(num(spec.min_shots_per_scene))} shot`);
  }
  if (num(spec.min_topic_minutes) !== null) {
    lines.push(
      `Mỗi chủ đề có tối thiểu ${formatNumber(num(spec.min_topic_minutes))} phút footage đạt yêu cầu`,
    );
  }
  const audioText =
    spec.require_audio === true ? 'Có âm thanh môi trường' : 'Không bắt buộc âm thanh';
  if (spec.require_audio === true) {
    lines.push('Video có âm thanh môi trường rõ, không bị nhiễu');
  }
  if (spec.reject_dead === true) {
    lines.push('Không nhận file lỗi, hỏng hoặc không phát được');
  }
  if (num(spec.min_quality) !== null) {
    lines.push(`Điểm chất lượng hình ảnh tối thiểu ${formatNumber(num(spec.min_quality))}`);
  }
  if (spec.uniform_within_project === true) {
    lines.push('Các file trong cùng dự án đồng nhất độ phân giải và tốc độ khung hình');
  }
  if (lines.length === 0) {
    lines.push('Theo thoả thuận của hai bên');
  }
  return {
    resolution: short,
    resolution_text: resolutionText,
    fps_text: fpsText,
    min_shot_seconds: optionalNumber(spec.min_shot_seconds),
    min_shots_per_scene: optionalNumber(spec.min_shots_per_scene),
    min_topic_minutes: optionalNumber(spec.min_topic_minutes),
    per_source_min_seconds: optionalNumber(spec.per_source_min_seconds),
    duration_rule_text: durationRuleText,
    audio_text: audioText,
    lines: lines.map((line, index) => ({ no: index + 1, text: line })),
    text: lines.join('; '),
  };
}

function tierSourcesText(price: RateCardPrice): string {
  if (price.sourceMin === null) {
    return NOT_APPLICABLE;
  }
  return price.sourceMax === null
    ? `từ ${formatNumber(price.sourceMin)} source`
    : `${formatNumber(price.sourceMin)}–${formatNumber(price.sourceMax)} source`;
}

/** Prices of the pricing model (Điều 2.1): unit price, or the rate card table for `package_tier`. */
export function pricingData(
  model: PricingModel,
  config: Record<string, unknown>,
  rateCard: RateCardFacts | null,
  productNames: readonly string[],
): RenderData {
  const unitPrice = num(config.unit_price);
  const unit = model === 'per_topic' ? 'topic' : model === 'per_unit' ? text(config.unit) : '';
  const tiers = (rateCard?.prices ?? [])
    .filter((price) => price.pricingType === 'tier')
    .map((price, index) => ({
      no: index + 1,
      product: price.product,
      tier: price.tier ?? '',
      tier_text: price.tier === null ? NOT_APPLICABLE : `Mức ${price.tier}`,
      sources_text: tierSourcesText(price),
      scenes: price.sceneMin === null ? NOT_APPLICABLE : formatNumber(price.sceneMin),
      price: formatMoney(price.price),
    }));
  const perSource = (rateCard?.prices ?? [])
    .filter((price) => price.pricingType === 'per_source')
    .map((price, index) => ({
      no: index + 1,
      product: price.product,
      price: formatMoney(price.price),
      min_seconds:
        price.minSourceSeconds === null ? NOT_APPLICABLE : formatNumber(price.minSourceSeconds),
    }));
  const topics = Array.isArray(config.topics) ? (config.topics as unknown[]).map(text) : [];
  const level = text(config.level);
  return {
    model,
    model_text: PRICING_MODEL_TEXT[model],
    is_per_topic: model === 'per_topic',
    is_per_unit: model === 'per_unit',
    is_package_tier: model === 'package_tier',
    unit: unit || NOT_APPLICABLE,
    unit_label: unit ? (UNIT_LABELS[unit as AcceptanceUnit] ?? unit) : 'gói sản phẩm',
    is_clip: unit === 'clip',
    unit_price: unitPrice === null ? NOT_APPLICABLE : formatMoney(unitPrice),
    unit_price_words: unitPrice === null ? NOT_APPLICABLE : words(unitPrice),
    min_topic_minutes: optionalNumber(config.min_topic_minutes),
    max_topic_minutes: optionalNumber(config.max_topic_minutes),
    topics_text: topics.length > 0 ? topics.join(', ') : 'Theo thoả thuận của hai bên',
    require_audio: config.require_audio === true,
    max_shots_per_clip: optionalNumber(config.max_shots_per_clip),
    min_shot_seconds: optionalNumber(config.min_shot_seconds),
    level: level || NOT_APPLICABLE,
    employment_stage_text: EMPLOYMENT_STAGE_TEXT[text(config.employment_stage)] ?? NOT_APPLICABLE,
    products_text: productNames.length > 0 ? productNames.join(', ') : NOT_APPLICABLE,
    has_rate_card: rateCard !== null,
    rate_card_code: rateCard?.code ?? NOT_APPLICABLE,
    rate_card_version: rateCard ? String(rateCard.version) : NOT_APPLICABLE,
    rate_card_effective_from: rateCard ? formatDate(rateCard.effectiveFrom) : NOT_APPLICABLE,
    tiers,
    per_source: perSource,
    has_per_source: perSource.length > 0,
    extra_scene_price:
      rateCard?.extraScenePrice === null || rateCard?.extraScenePrice === undefined
        ? NOT_APPLICABLE
        : formatMoney(rateCard.extraScenePrice),
    extra_scene_min_sources:
      rateCard?.extraSceneMinSources === null || rateCard?.extraSceneMinSources === undefined
        ? NOT_APPLICABLE
        : formatNumber(rateCard.extraSceneMinSources),
  };
}

export function contractData(contract: ContractFacts, documentDate: string): RenderData {
  const cap = contract.capAmount;
  const advance = contract.advanceAmount;
  return {
    number: text(contract.contractNumber),
    signed_date: formatDate(contract.signedDate),
    signed_date_text: formatLongDate(contract.signedDate),
    /** Date printed at the top ("Hôm nay, ngày …"): the signing date, or the day it is issued. */
    document_date: formatDate(contract.signedDate ?? documentDate),
    document_date_text: formatLongDate(contract.signedDate ?? documentDate),
    start_date: formatDate(contract.startDate),
    start_date_text: formatLongDate(contract.startDate),
    end_date: contract.endDate ? formatDate(contract.endDate) : NOT_APPLICABLE,
    end_date_text: contract.endDate
      ? formatLongDate(contract.endDate)
      : 'đến khi hai bên hoàn thành nghĩa vụ',
    pricing_model_text: PRICING_MODEL_TEXT[contract.pricingModel],
    has_cap: cap !== null,
    cap_amount: cap === null ? 'Không giới hạn' : formatMoney(cap),
    cap_amount_words: cap === null ? NOT_APPLICABLE : words(cap),
    has_advance: advance > 0,
    advance_amount: formatMoney(advance),
    advance_amount_words: advance > 0 ? words(advance) : NOT_APPLICABLE,
    advance_due_business_days: optionalNumber(contract.advanceDueBusinessDays),
    payment_term_business_days: formatNumber(contract.paymentTermBusinessDays),
    payment_term: `${formatNumber(contract.paymentTermBusinessDays)} ngày làm việc`,
    acceptance_cycle_text:
      ACCEPTANCE_CYCLE_TEXT[contract.acceptanceCycle] ?? contract.acceptanceCycle,
    delivery_rule_text: deliveryRuleText(contract.deliveryRule, contract.acceptanceCycle),
    penalty_percent: formatNumber(contract.penaltyPercent),
    originality_min_percent: optionalNumber(contract.originalityMinPercent),
    has_originality: contract.originalityMinPercent !== null,
    similarity_max_percent: optionalNumber(contract.similarityMaxPercent),
    non_compete_months: optionalNumber(contract.nonCompeteMonths),
  };
}

// ---------------------------------------------------------------------------
// Amendment
// ---------------------------------------------------------------------------

const AMENDMENT_LABELS: Record<string, string> = {
  pricing_config: 'Giá và cấu hình giá',
  cap_amount: 'Giá trị tối đa của hợp đồng',
  tech_spec: 'Yêu cầu kỹ thuật',
  end_date: 'Ngày kết thúc hợp đồng',
  payment_term_business_days: 'Thời hạn thanh toán',
  penalty_percent: 'Mức phạt vi phạm',
};

function pricingChangeText(
  model: PricingModel,
  config: Record<string, unknown>,
  productNames: readonly string[],
): string {
  const pricing = pricingData(model, config, null, productNames);
  if (model === 'package_tier') {
    return `Cấp ${String(pricing.level)}, sản phẩm: ${String(pricing.products_text)}, giai đoạn: ${String(pricing.employment_stage_text)}; đơn giá theo bảng giá CTV hiện hành`;
  }
  const parts = [`Đơn giá ${String(pricing.unit_price)} đồng/${String(pricing.unit_label)}`];
  if (model === 'per_topic') {
    parts.push(`mỗi chủ đề tối thiểu ${String(pricing.min_topic_minutes)} phút`);
  } else if (pricing.is_clip) {
    parts.push(`mỗi clip tối đa ${String(pricing.max_shots_per_clip)} shot`);
  }
  return parts.join(', ');
}

export function amendmentData(
  amendment: AmendmentFacts,
  model: PricingModel,
  productNames: readonly string[],
): RenderData {
  const changes = Object.entries(amendment.changes).map(([column, value], index) => {
    let valueText: string;
    switch (column) {
      case 'pricing_config':
        valueText = pricingChangeText(
          model,
          (value ?? {}) as Record<string, unknown>,
          productNames,
        );
        break;
      case 'tech_spec':
        valueText = String(techSpecData((value ?? {}) as Record<string, unknown>).text);
        break;
      case 'cap_amount':
        valueText =
          value === null
            ? 'Không giới hạn'
            : `${formatMoney(value as number)} đồng (${words(value as number)})`;
        break;
      case 'end_date':
        valueText = value ? formatDate(value as string) : 'Đến khi hai bên hoàn thành nghĩa vụ';
        break;
      case 'payment_term_business_days':
        valueText = `${formatNumber(value as number)} ngày làm việc`;
        break;
      case 'penalty_percent':
        valueText = `${formatNumber(value as number)}% giá trị hợp đồng`;
        break;
      default:
        valueText = text(typeof value === 'object' ? JSON.stringify(value) : value);
    }
    return { no: index + 1, label: AMENDMENT_LABELS[column] ?? column, value: valueText };
  });
  return {
    number: String(amendment.amendmentNumber),
    effective_date: formatDate(amendment.effectiveDate),
    effective_date_text: formatLongDate(amendment.effectiveDate),
    reason: text(amendment.reason) || NOT_APPLICABLE,
    changes,
  };
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/** Header of the quantity column by pricing model (Phụ lục B.2). */
export function quantityHeader(model: PricingModel, config: Record<string, unknown>): string {
  if (model === 'per_topic') {
    return 'Số chủ đề';
  }
  if (model === 'per_unit') {
    return config.unit === 'clip' ? 'Số clip' : 'Số shot';
  }
  return 'Số source – Số bối cảnh';
}

function itemData(item: AcceptanceItemFacts, resolution: string): RenderData {
  const metrics = item.metrics ?? {};
  const sources = num(metrics.sources);
  const scenes = num(metrics.scenes);
  const tier = num(metrics.tier);
  const unitLabel = UNIT_LABELS[item.unit] ?? item.unit;
  let quantityText = `${formatNumber(item.quantity)} ${unitLabel}`;
  if (item.unit === 'package') {
    quantityText = `${formatNumber(sources ?? 0)} source – ${formatNumber(scenes ?? 0)} bối cảnh`;
  } else if (item.unit === 'extra_scene') {
    quantityText = `${formatNumber(item.quantity)} bối cảnh`;
  }
  return {
    line_no: String(item.lineNo),
    label: text(item.productLabel),
    unit: item.unit,
    unit_label: unitLabel,
    quantity: formatNumber(item.quantity),
    quantity_text: quantityText,
    sources: item.unit === 'package' && sources !== null ? formatNumber(sources) : NOT_APPLICABLE,
    scenes:
      (item.unit === 'package' || item.unit === 'extra_scene') && scenes !== null
        ? formatNumber(scenes)
        : NOT_APPLICABLE,
    tier_text: tier === null ? NOT_APPLICABLE : `Mức ${tier}`,
    resolution,
    unit_price: formatMoney(item.unitPrice),
    amount: formatMoney(item.amount),
  };
}

export function acceptanceData(
  acceptance: AcceptanceFacts,
  model: PricingModel,
  config: Record<string, unknown>,
  resolution: string,
): { acceptance: RenderData; items: RenderData[] } {
  const items = [...acceptance.items]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((item) => itemData(item, resolution));
  const netWords =
    acceptance.netPayableWords?.trim() || acceptanceMoneyWords(acceptance.netPayable);
  return {
    acceptance: {
      appendix_number: acceptance.appendixNumber === null ? '' : String(acceptance.appendixNumber),
      record_date: formatDate(acceptance.recordDate),
      record_date_text: formatLongDate(acceptance.recordDate),
      period_start: formatDate(acceptance.periodStart),
      period_end: formatDate(acceptance.periodEnd),
      period_text: `từ ${formatDate(acceptance.periodStart)} đến ${formatDate(acceptance.periodEnd)}`,
      delivery_method: acceptance.deliveryMethod,
      delivery_method_text: DELIVERY_METHOD_TEXT[acceptance.deliveryMethod],
      delivery_note: text(acceptance.deliveryNote),
      quantity_header: quantityHeader(model, config),
      item_count: String(items.length),
      gross: formatMoney(acceptance.grossAmount),
      gross_words: acceptanceMoneyWords(acceptance.grossAmount),
      tax_rate: formatNumber(acceptance.taxRate),
      tax: formatMoney(acceptance.taxAmount),
      has_advance_offset: acceptance.advanceOffsetAmount > 0,
      advance_offset: formatMoney(acceptance.advanceOffsetAmount),
      net: formatMoney(acceptance.netPayable),
      net_words: netWords,
    },
    items,
  };
}

// ---------------------------------------------------------------------------

/** Everything a template of `input.kind` may use. */
export function buildRenderData(input: RenderInput): RenderData {
  const tech = techSpecData(input.techSpec);
  const data: RenderData = {
    document: {
      kind: input.kind,
      date: formatDate(input.documentDate),
      date_text: formatLongDate(input.documentDate),
      is_draft: input.draft,
    },
    company: companyData(input.company),
    partner: partnerData(input.partner),
    contract: contractData(input.contract, input.documentDate),
    pricing: pricingData(
      input.contract.pricingModel,
      input.pricingConfig,
      input.rateCard,
      input.productNames,
    ),
    tech_spec: tech,
  };
  if (input.kind === 'amendment' && input.amendment) {
    data.amendment = amendmentData(
      input.amendment,
      input.contract.pricingModel,
      input.productNames,
    );
  }
  if (input.kind === 'acceptance' && input.acceptance) {
    const built = acceptanceData(
      input.acceptance,
      input.contract.pricingModel,
      input.pricingConfig,
      String(tech.resolution),
    );
    data.acceptance = built.acceptance;
    data.items = built.items;
    // AG Music's names (ReportRenderDataBuilder), one convention for both apps.
    data.total_acceptance_value = built.acceptance.gross;
    data.personal_income_tax = built.acceptance.tax;
    data.actual_amount_received_number = built.acceptance.net;
    data.actual_amount_received_string = built.acceptance.net_words;
  }
  return data;
}
