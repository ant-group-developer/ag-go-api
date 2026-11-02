import { z } from 'zod';
import type { PricingModel } from '../../database/entities/contract.entity';

const money = z.int().positive();
const count = z.int().nonnegative();

/** `per_topic` (D1): one approved project of at least `min_topic_minutes` is one topic. */
export const PerTopicConfigSchema = z
  .strictObject({
    unit_price: money,
    min_topic_minutes: z.int().positive(),
    /** Warning only: longer topics are not cut. */
    max_topic_minutes: z.int().positive().optional(),
    topics: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    require_audio: z.boolean().default(true),
  })
  .refine(
    (config) =>
      config.max_topic_minutes === undefined ||
      config.max_topic_minutes >= config.min_topic_minutes,
    {
      message: 'max_topic_minutes must be at least min_topic_minutes',
      path: ['max_topic_minutes'],
    },
  );

/** `per_unit` (D3/D4): paid per approved shot, or per clip of up to `max_shots_per_clip` shots. */
export const PerUnitConfigSchema = z
  .strictObject({
    unit: z.enum(['shot', 'clip']),
    unit_price: money,
    max_shots_per_clip: z.int().positive().optional(),
    min_shot_seconds: count.optional(),
  })
  .refine((config) => config.unit !== 'clip' || config.max_shots_per_clip !== undefined, {
    message: 'max_shots_per_clip is required when unit is clip',
    path: ['max_shots_per_clip'],
  });

/** `package_tier` (D7): prices come from the shared rate card; the contract picks level and products. */
export const PackageTierConfigSchema = z.strictObject({
  /** Rate card code; its version is the one in force on the last day of the acceptance period. */
  rate_card_id: z.string().trim().min(1).max(50),
  level: z.enum(['LV1', 'LV2', 'LV3']),
  /** Products (categories) this contract may deliver. */
  category_ids: z.array(z.uuid()).min(1).max(50),
  employment_stage: z.enum(['probation', 'apprentice', 'official']).default('official'),
});

export const PRICING_CONFIG_SCHEMAS = {
  per_topic: PerTopicConfigSchema,
  per_unit: PerUnitConfigSchema,
  package_tier: PackageTierConfigSchema,
} as const satisfies Record<PricingModel, z.ZodType>;

/** Technical requirements on delivered media (spec 8.1); every rule is optional. */
export const TechSpecSchema = z.strictObject({
  min_width: z.int().positive().nullable().optional(),
  min_height: z.int().positive().nullable().optional(),
  fps: z
    .strictObject({ target: z.number().positive(), tolerance: z.number().nonnegative() })
    .nullable()
    .optional(),
  min_shot_seconds: count.nullable().optional(),
  source_duration_rule: z
    .strictObject({
      min_seconds: count,
      preferred_seconds: count,
      preferred_ratio: z.number().min(0).max(1),
    })
    .nullable()
    .optional(),
  per_source_min_seconds: count.nullable().optional(),
  min_shots_per_scene: count.nullable().optional(),
  min_topic_minutes: count.nullable().optional(),
  require_audio: z.boolean().optional(),
  reject_dead: z.boolean().optional(),
  min_quality: z.number().min(0).max(1).nullable().optional(),
  uniform_within_project: z.boolean().optional(),
});

export type TechSpec = z.infer<typeof TechSpecSchema>;

/** When the partner delivers: monthly before a day (e.g. the 15th), or freely. */
export const DeliveryRuleSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('monthly_before_day'), day: z.int().min(1).max(31) }),
  z.strictObject({ type: z.literal('flexible') }),
]);

/** Tech spec presets offered when creating a contract (FR-C-03). */
export const TECH_SPEC_PRESETS: Record<string, { label: string; techSpec: TechSpec }> = {
  footage_4k60: {
    label: 'Footage 4K60',
    techSpec: {
      min_width: 3840,
      min_height: 2160,
      fps: { target: 60, tolerance: 0.1 },
      source_duration_rule: { min_seconds: 10, preferred_seconds: 20, preferred_ratio: 0.8 },
      per_source_min_seconds: 300,
      min_shots_per_scene: 5,
      require_audio: false,
      reject_dead: true,
      min_quality: null,
      uniform_within_project: true,
    },
  },
  topic_video: {
    label: 'Chủ đề có âm thanh (per_topic)',
    techSpec: {
      min_width: 1920,
      min_height: 1080,
      min_topic_minutes: 20,
      require_audio: true,
      reject_dead: true,
      uniform_within_project: false,
    },
  },
  shot_4k: {
    label: 'Shot 4K ≥ 60 giây (per_unit)',
    techSpec: {
      min_width: 3840,
      min_height: 2160,
      min_shot_seconds: 60,
      min_shots_per_scene: 5,
      reject_dead: true,
      uniform_within_project: true,
    },
  },
};

export const DEFAULT_TECH_SPEC_PRESET = 'footage_4k60';

export type TermsErrors = Record<string, string[]>;

function issues(error: z.ZodError, field: string, errors: TermsErrors): void {
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? `${field}.${issue.path.join('.')}` : field;
    (errors[field] ??= []).push(`${path}: ${issue.message}`);
  }
}

export type ContractTermsInput = {
  pricingModel: PricingModel;
  pricingConfig: unknown;
  techSpec: unknown;
  deliveryRule?: unknown;
  capAmount?: number | null;
  advanceAmount?: number | null;
  advanceDueBusinessDays?: number | null;
  startDate?: string | null;
  endDate?: string | null;
};

export type ValidatedTerms = {
  pricingConfig: Record<string, unknown>;
  techSpec: Record<string, unknown>;
  deliveryRule: Record<string, unknown> | null;
};

/**
 * Checks the terms of a contract (FR-C-01, FR-C-04): the pricing config against the schema of its
 * model, the tech spec, the delivery rule, advance ≤ ceiling with a due date, end ≥ start.
 * Returns the normalised JSON (defaults applied) or the errors by field.
 */
export function validateContractTerms(
  input: ContractTermsInput,
): { ok: true; value: ValidatedTerms } | { ok: false; errors: TermsErrors } {
  const errors: TermsErrors = {};
  const pricing = PRICING_CONFIG_SCHEMAS[input.pricingModel].safeParse(input.pricingConfig);
  if (!pricing.success) {
    issues(pricing.error, 'pricingConfig', errors);
  }
  const techSpec = TechSpecSchema.safeParse(input.techSpec);
  if (!techSpec.success) {
    issues(techSpec.error, 'techSpec', errors);
  }
  let deliveryRule: Record<string, unknown> | null = null;
  if (input.deliveryRule !== undefined && input.deliveryRule !== null) {
    const parsed = DeliveryRuleSchema.safeParse(input.deliveryRule);
    if (parsed.success) {
      deliveryRule = parsed.data;
    } else {
      issues(parsed.error, 'deliveryRule', errors);
    }
  }
  const advance = input.advanceAmount ?? 0;
  if (input.capAmount !== undefined && input.capAmount !== null && advance > input.capAmount) {
    (errors.advanceAmount ??= []).push('advanceAmount must not exceed capAmount');
  }
  if (
    advance > 0 &&
    (input.advanceDueBusinessDays === undefined || input.advanceDueBusinessDays === null)
  ) {
    (errors.advanceDueBusinessDays ??= []).push(
      'advanceDueBusinessDays is required when there is an advance',
    );
  }
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    (errors.endDate ??= []).push('endDate must not be before startDate');
  }
  if (Object.keys(errors).length > 0 || !pricing.success || !techSpec.success) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      pricingConfig: pricing.data as Record<string, unknown>,
      techSpec: techSpec.data as Record<string, unknown>,
      deliveryRule,
    },
  };
}

/** Terms an amendment may change (spec 7.3), with their column names as stored in `changes`. */
export const AMENDABLE_TERMS = [
  'pricing_config',
  'cap_amount',
  'tech_spec',
  'end_date',
  'payment_term_business_days',
  'penalty_percent',
] as const;

export type AmendableTerm = (typeof AMENDABLE_TERMS)[number];

export type ContractTerms = {
  pricing_model: PricingModel;
  pricing_config: Record<string, unknown>;
  cap_amount: number | null;
  tech_spec: Record<string, unknown>;
  end_date: string | null;
  payment_term_business_days: number;
  penalty_percent: number;
};

export type SignedAmendment = {
  amendmentNumber: number;
  effectiveDate: string;
  status: string;
  changes: Record<string, unknown>;
};

/**
 * Terms in force on `date` (YYYY-MM-DD): the contract's, with every signed amendment effective on
 * or before that day applied in number order (spec 7.3, FR-C-07).
 */
export function effectiveTerms(
  base: ContractTerms,
  amendments: readonly SignedAmendment[],
  date: string,
): ContractTerms & { appliedAmendments: number[] } {
  const terms: ContractTerms = { ...base };
  const applied: number[] = [];
  const inForce = amendments
    .filter((amendment) => amendment.status === 'signed' && amendment.effectiveDate <= date)
    .sort((left, right) => left.amendmentNumber - right.amendmentNumber);
  for (const amendment of inForce) {
    for (const term of AMENDABLE_TERMS) {
      if (term in amendment.changes) {
        (terms as Record<string, unknown>)[term] = amendment.changes[term];
      }
    }
    applied.push(amendment.amendmentNumber);
  }
  return { ...terms, appliedAmendments: applied };
}
