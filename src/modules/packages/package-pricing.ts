import type { EntityManager } from 'typeorm';
import { computePackageTier, type PackageTierResult } from '../pricing-engine/package-tier';
import {
  levelRuleFor,
  perSourceItemFor,
  tiersFor,
  type CtvLevel,
} from '../pricing-engine/rate-card';
import { contractOn, packageProjectFacts } from '../pricing-facts/pricing-facts';
import { findRateCardInForce } from '../rate-cards/rate-cards.service';

export type PackagePreviewProject = {
  projectId: string;
  name: string;
  evaluationStatus: string;
  pendingMedia: number;
  files: number;
  shortFiles: number;
  unknownDuration: number;
  validSources: number;
  preferredSources: number;
  counted: boolean;
  reason: string | null;
  message: string | null;
};

export type PackagePricing = {
  /** `provisional` counts pending media (open / submitted); `final` only evaluated work. */
  mode: 'provisional' | 'final';
  /** Day the rate card and the contract terms are taken on. */
  day: string;
  rateCard: { id: string; code: string; version: number } | null;
  level: CtvLevel | null;
  result: PackageTierResult | null;
  projects: PackagePreviewProject[];
  /** Why it cannot be priced (no rate card in force, no tier for the product…). */
  problems: Array<{ code: string; message: string }>;
};

/**
 * Prices one package (BR-13, BR-17) on `day` (Q-R1: the last day of the acceptance period, or
 * today for a preview): contract terms with signed amendments, the rate card version in force,
 * per-project counts aggregated in SQL.
 */
export async function pricePackage(
  manager: EntityManager,
  pkg: { id: string; contractId: string; categoryId: string },
  day: string,
  mode: 'provisional' | 'final',
): Promise<PackagePricing> {
  const problems: PackagePricing['problems'] = [];
  const base = { mode, day, rateCard: null, level: null, result: null };
  const projectIds = (
    (await manager.query(`SELECT id FROM projects WHERE package_id = $1`, [pkg.id])) as Array<{
      id: string;
    }>
  ).map((row) => row.id);

  const loaded = await contractOn(manager, pkg.contractId, day);
  const config = (loaded?.terms.pricing_config ?? {}) as { rate_card_id?: string; level?: string };
  const level = (config.level ?? null) as CtvLevel | null;
  const code = config.rate_card_id ?? null;
  const card = code ? await findRateCardInForce(manager, code, day) : null;
  if (!card || !level) {
    problems.push({
      code: 'RATE_CARD_NOT_IN_FORCE',
      message: code
        ? `Không có bảng giá ${code} đã phát hành hiệu lực ngày ${day}`
        : 'HĐ chưa chọn bảng giá và cấp CTV',
    });
  }
  const facts = await packageProjectFacts(
    manager,
    projectIds,
    card?.content.durationRule ?? { minSeconds: 10, preferredSeconds: 20, preferredRatio: 0.8 },
    mode === 'provisional',
  );
  const asProjects = (result: PackageTierResult | null): PackagePreviewProject[] =>
    facts.map((fact) => {
      const line = result?.projects.find((project) => project.projectId === fact.projectId);
      return {
        projectId: fact.projectId,
        name: fact.name,
        evaluationStatus: fact.evaluationStatus,
        pendingMedia: fact.pendingMedia,
        files: fact.files,
        shortFiles: fact.shortFiles,
        unknownDuration: fact.unknownDuration,
        validSources: fact.validSources,
        preferredSources: fact.preferredSources,
        counted: line?.counted ?? false,
        reason: line?.reason ?? null,
        message: line?.message ?? null,
      };
    });
  if (!card || !level) {
    return { ...base, level, projects: asProjects(null), problems };
  }
  const rateCard = { id: card.id, code: card.code, version: card.version };
  const tiers = tiersFor(card.content.items, pkg.categoryId, level);
  const rule = levelRuleFor(card.content.levelRules, level);
  if (tiers.length === 0 || !rule) {
    problems.push({
      code: perSourceItemFor(card.content.items, pkg.categoryId)
        ? 'CATEGORY_PER_SOURCE'
        : 'NO_TIER_PRICE',
      message: `Bảng giá ${card.code} v${card.version} không có giá theo Mức của sản phẩm này ở cấp ${level}`,
    });
    return { ...base, rateCard, level, projects: asProjects(null), problems };
  }
  const result = computePackageTier({
    tiers,
    extraScenePrice: rule.extraScenePrice,
    extraSceneMinSources: rule.extraSceneMinSources,
    durationRule: card.content.durationRule,
    projects: facts,
    mode,
  });
  return { mode, day, rateCard, level, result, projects: asProjects(result), problems };
}

/** What is stored in `product_packages.preview` (spec 7.4.1). */
export function previewSummary(pricing: PackagePricing): Record<string, unknown> {
  const result = pricing.result;
  return {
    mode: pricing.mode,
    day: pricing.day,
    rateCard: pricing.rateCard,
    level: pricing.level,
    sources: result?.sources ?? 0,
    scenes: result?.scenes ?? 0,
    excludedScenes: result?.excludedScenes ?? 0,
    tier: result?.tier ?? null,
    tierPrice: result?.tierPrice ?? 0,
    extraScenes: result?.extraScenes ?? 0,
    extraAmount: result?.extraAmount ?? 0,
    amount: result?.amount ?? 0,
    durationRatio: result?.durationRatio ?? null,
    durationRuleMet: result?.durationRuleMet ?? true,
    next: result?.next ?? null,
    warnings: [...pricing.problems, ...(result?.warnings ?? [])],
  };
}
