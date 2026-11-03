import type { DurationRule } from './durations';

/**
 * CTV rate card (spec 7.2.1): prices by product (category) × level × tier, versioned with an
 * effective date. Pure data shapes and lookups; the rate-cards module stores them.
 */

export const CTV_LEVELS = ['LV1', 'LV2', 'LV3'] as const;
export type CtvLevel = (typeof CTV_LEVELS)[number];
/** Level of items not split by level (Lái xe, Flycam). */
export const ALL_LEVELS = 'ALL';
export type RateCardLevel = CtvLevel | typeof ALL_LEVELS;

export const RATE_CARD_PRICING_TYPES = ['tier', 'per_source'] as const;
export type RateCardPricingType = (typeof RATE_CARD_PRICING_TYPES)[number];

export const RATE_CARD_STATUSES = ['draft', 'published', 'archived'] as const;
export type RateCardStatus = (typeof RATE_CARD_STATUSES)[number];

export type RateCardItemData = {
  id?: string | null;
  categoryId: string;
  level: RateCardLevel;
  pricingType: RateCardPricingType;
  tier: number | null;
  sourceMin: number | null;
  /** Display only: more sources than the top tier's max is still that tier (BR-13). */
  sourceMax: number | null;
  sceneMin: number | null;
  price: number;
  /** `per_source`: shorter files are not paid (Lái xe / Flycam 300 s). */
  minSourceSeconds: number | null;
};

export type LevelRuleData = {
  level: CtvLevel;
  /** Paid per scene beyond the top tier's scene minimum. */
  extraScenePrice: number;
  /** Sources a project needs to count as a scene (Q-R2: every scene). */
  extraSceneMinSources: number;
};

export type RateCardVersionRef = {
  version: number;
  status: RateCardStatus;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  effectiveTo: string | null;
};

/**
 * Version in force on `date` (YYYY-MM-DD): published, `effectiveFrom ≤ date ≤ effectiveTo` (open
 * end when null), the highest version when several match. Q-R1: `date` is the last day of the
 * acceptance period.
 */
export function selectRateCardVersion<T extends RateCardVersionRef>(
  versions: readonly T[],
  date: string,
): T | null {
  let best: T | null = null;
  for (const candidate of versions) {
    if (
      candidate.status === 'published' &&
      candidate.effectiveFrom <= date &&
      (candidate.effectiveTo === null || candidate.effectiveTo >= date) &&
      (best === null || candidate.version > best.version)
    ) {
      best = candidate;
    }
  }
  return best;
}

export type TierPrice = {
  tier: number;
  sourceMin: number;
  sourceMax: number | null;
  sceneMin: number;
  price: number;
  itemId: string | null;
};

/** Tiers of one product and level, lowest first. */
export function tiersFor(
  items: readonly RateCardItemData[],
  categoryId: string,
  level: CtvLevel,
): TierPrice[] {
  return items
    .filter(
      (item) =>
        item.pricingType === 'tier' &&
        item.categoryId === categoryId &&
        item.level === level &&
        item.tier !== null,
    )
    .map((item) => ({
      tier: item.tier as number,
      sourceMin: item.sourceMin ?? 0,
      sourceMax: item.sourceMax,
      sceneMin: item.sceneMin ?? 0,
      price: item.price,
      itemId: item.id ?? null,
    }))
    .sort((left, right) => left.tier - right.tier);
}

/** The per-source price of a product (Lái xe, Flycam), if it is priced that way. */
export function perSourceItemFor(
  items: readonly RateCardItemData[],
  categoryId: string,
): RateCardItemData | null {
  return (
    items.find((item) => item.pricingType === 'per_source' && item.categoryId === categoryId) ??
    null
  );
}

export function levelRuleFor(
  rules: readonly LevelRuleData[],
  level: CtvLevel,
): LevelRuleData | null {
  return rules.find((rule) => rule.level === level) ?? null;
}

export type RateCardContent = {
  durationRule: DurationRule;
  items: readonly RateCardItemData[];
  levelRules: readonly LevelRuleData[];
};

/**
 * Checks a rate card before it is saved: one cell per product × level × tier, tiers numbered from 1
 * with non-decreasing source / scene minimums, per-source items at level ALL without tier, a level
 * rule for every level used, a sensible duration rule. Returns the problems (empty = valid).
 */
export function validateRateCard(content: RateCardContent): string[] {
  const errors: string[] = [];
  const rule = content.durationRule;
  if (
    !Number.isInteger(rule.minSeconds) ||
    !Number.isInteger(rule.preferredSeconds) ||
    rule.minSeconds < 0 ||
    rule.preferredSeconds < rule.minSeconds ||
    !(rule.preferredRatio >= 0 && rule.preferredRatio <= 1)
  ) {
    errors.push('durationRule: cần 0 ≤ minSeconds ≤ preferredSeconds và 0 ≤ preferredRatio ≤ 1');
  }
  const seen = new Set<string>();
  const groups = new Map<string, RateCardItemData[]>();
  const levelsUsed = new Set<CtvLevel>();
  const perSourceCategories = new Set<string>();
  const tierCategories = new Set<string>();
  content.items.forEach((item, index) => {
    const at = `items[${index}]`;
    if (!Number.isSafeInteger(item.price) || item.price < 0) {
      errors.push(`${at}.price: phải là số nguyên không âm`);
    }
    if (item.pricingType === 'per_source') {
      perSourceCategories.add(item.categoryId);
      if (item.level !== ALL_LEVELS || item.tier !== null) {
        errors.push(`${at}: giá theo source dùng level ALL và không có Mức`);
      }
      if (item.minSourceSeconds !== null && item.minSourceSeconds < 0) {
        errors.push(`${at}.minSourceSeconds: không được âm`);
      }
      const key = `${item.categoryId}|source`;
      if (seen.has(key)) {
        errors.push(`${at}: trùng giá theo source của sản phẩm ${item.categoryId}`);
      }
      seen.add(key);
      return;
    }
    tierCategories.add(item.categoryId);
    if (item.level === ALL_LEVELS) {
      errors.push(`${at}.level: giá theo Mức cần cấp LV1/LV2/LV3`);
      return;
    }
    levelsUsed.add(item.level);
    if (item.tier === null || !Number.isInteger(item.tier) || item.tier < 1) {
      errors.push(`${at}.tier: Mức phải là số nguyên ≥ 1`);
      return;
    }
    if (
      item.sourceMin === null ||
      item.sceneMin === null ||
      item.sourceMin < 0 ||
      item.sceneMin < 0 ||
      (item.sourceMax !== null && item.sourceMax < item.sourceMin)
    ) {
      errors.push(`${at}: cần sourceMin, sceneMin ≥ 0 và sourceMax ≥ sourceMin`);
      return;
    }
    const key = `${item.categoryId}|${item.level}|${item.tier}`;
    if (seen.has(key)) {
      errors.push(
        `${at}: trùng ô giá ${item.level} Mức ${item.tier} của sản phẩm ${item.categoryId}`,
      );
    }
    seen.add(key);
    const group = `${item.categoryId}|${item.level}`;
    groups.set(group, [...(groups.get(group) ?? []), item]);
  });
  for (const categoryId of perSourceCategories) {
    if (tierCategories.has(categoryId)) {
      errors.push(`Sản phẩm ${categoryId} không thể vừa tính theo Mức vừa theo source`);
    }
  }
  for (const [group, items] of groups) {
    const sorted = [...items].sort((left, right) => (left.tier as number) - (right.tier as number));
    sorted.forEach((item, index) => {
      if (item.tier !== index + 1) {
        errors.push(`${group}: các Mức phải liên tiếp từ 1`);
      }
      const previous = sorted[index - 1];
      if (
        previous &&
        ((item.sourceMin as number) < (previous.sourceMin as number) ||
          (item.sceneMin as number) < (previous.sceneMin as number))
      ) {
        errors.push(`${group}: Mức ${item.tier} không được thấp hơn Mức ${previous.tier}`);
      }
    });
  }
  const ruleLevels = new Set<CtvLevel>();
  content.levelRules.forEach((levelRule, index) => {
    if (ruleLevels.has(levelRule.level)) {
      errors.push(`levelRules[${index}]: trùng cấp ${levelRule.level}`);
    }
    ruleLevels.add(levelRule.level);
    if (
      !Number.isSafeInteger(levelRule.extraScenePrice) ||
      levelRule.extraScenePrice < 0 ||
      !Number.isInteger(levelRule.extraSceneMinSources) ||
      levelRule.extraSceneMinSources < 0
    ) {
      errors.push(`levelRules[${index}]: phụ trội và số source tối thiểu phải là số nguyên ≥ 0`);
    }
  });
  for (const level of levelsUsed) {
    if (!ruleLevels.has(level)) {
      errors.push(`levelRules: thiếu quy tắc của cấp ${level}`);
    }
  }
  return errors;
}
