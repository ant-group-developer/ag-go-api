import {
  addSourceCounts,
  durationRatio,
  EMPTY_SOURCE_COUNTS,
  formatPercent,
  type DurationRule,
  type SourceCounts,
} from './durations';
import { PricingError } from './pricing-error';
import type { TierPrice } from './rate-card';

/**
 * `package_tier` (BR-13, BR-17): the price of one product package (spec 7.4.1) from its sources and
 * scenes (1 project = 1 scene, 1 video = 1 source).
 */

export type PackageProjectFacts = SourceCounts & {
  projectId: string;
  /**
   * Evaluation finished (no media pending). Required for the project to count as a scene in the
   * final computation; the provisional preview of an open package counts pending media too.
   */
  evaluated: boolean;
};

export type PackageTierInput = {
  /** Tiers of the package's product at the contract's level, from the rate card version in force. */
  tiers: readonly TierPrice[];
  extraScenePrice: number;
  /** Sources a project needs to count as a scene (8 for LV1/LV2, 13 for LV3; Q-R2). */
  extraSceneMinSources: number;
  durationRule: DurationRule;
  projects: readonly PackageProjectFacts[];
  /**
   * `final`: only evaluated projects count as scenes (acceptance record); `provisional`: every
   * project counts on what it has so far (preview of an open / submitted package, FR-K-03).
   */
  mode: 'final' | 'provisional';
};

export type SceneExclusion = 'not_evaluated' | 'too_few_sources';

export type PackageProjectResult = {
  projectId: string;
  counted: boolean;
  reason: SceneExclusion | null;
  message: string | null;
  validSources: number;
};

export type PricingWarning = { code: string; message: string };

export type NextTierHint = {
  tier: number;
  missingSources: number;
  missingScenes: number;
  message: string;
};

export type PackageTierResult = {
  /** Projects counted as scenes. */
  scenes: number;
  /** Projects in the package not counted as scenes. */
  excludedScenes: number;
  /** Totals over the counted scenes only (BR-13: sources of scenes that count). */
  sources: number;
  preferredSources: number;
  shortFiles: number;
  unknownDuration: number;
  durationRatio: number | null;
  durationRuleMet: boolean;
  /** Highest tier reached on both sources and scenes; null below tier 1. */
  tier: number | null;
  tierPrice: number;
  tierItemId: string | null;
  /** Scenes beyond the top tier's scene minimum (only once the top tier is reached). */
  extraScenes: number;
  extraScenePrice: number;
  extraAmount: number;
  /** tierPrice + extraAmount. */
  amount: number;
  /** Tier the sources alone would reach (to suggest adding scenes / splitting, BR-13). */
  sourceTier: number | null;
  projects: PackageProjectResult[];
  /** What is missing for the next tier; null once the top tier is reached. */
  next: NextTierHint | null;
  belowTier1: boolean;
  warnings: PricingWarning[];
};

/** "thiếu 10 source và 2 bối cảnh" */
export function missingMessage(missingSources: number, missingScenes: number): string {
  const parts: string[] = [];
  if (missingSources > 0) {
    parts.push(`${missingSources} source`);
  }
  if (missingScenes > 0) {
    parts.push(`${missingScenes} bối cảnh`);
  }
  return parts.length > 0 ? `thiếu ${parts.join(' và ')}` : 'đã đủ';
}

function checkTiers(tiers: readonly TierPrice[]): TierPrice[] {
  const sorted = [...tiers].sort((left, right) => left.tier - right.tier);
  if (sorted.length === 0) {
    throw new PricingError('INVALID_INPUT', 'Bảng giá không có Mức cho sản phẩm và cấp này');
  }
  return sorted;
}

/** Highest tier with `value ≥ min` on the given dimension(s). */
function reached(
  tiers: readonly TierPrice[],
  sources: number,
  scenes: number | null,
): TierPrice | null {
  let best: TierPrice | null = null;
  for (const tier of tiers) {
    if (sources >= tier.sourceMin && (scenes === null || scenes >= tier.sceneMin)) {
      best = tier;
    }
  }
  return best;
}

export function computePackageTier(input: PackageTierInput): PackageTierResult {
  const tiers = checkTiers(input.tiers);
  const projects: PackageProjectResult[] = [];
  let counted: SourceCounts = { ...EMPTY_SOURCE_COUNTS };
  let unknownDuration = 0;
  for (const project of input.projects) {
    unknownDuration += project.unknownDuration;
    if (input.mode === 'final' && !project.evaluated) {
      projects.push({
        projectId: project.projectId,
        counted: false,
        reason: 'not_evaluated',
        message: 'Dự án chưa nghiệm thu xong',
        validSources: project.validSources,
      });
      continue;
    }
    if (project.validSources < input.extraSceneMinSources) {
      projects.push({
        projectId: project.projectId,
        counted: false,
        reason: 'too_few_sources',
        message: `Chỉ có ${project.validSources} source hợp lệ, cần tối thiểu ${input.extraSceneMinSources} để tính là bối cảnh`,
        validSources: project.validSources,
      });
      continue;
    }
    counted = addSourceCounts(counted, project);
    projects.push({
      projectId: project.projectId,
      counted: true,
      reason: null,
      message: null,
      validSources: project.validSources,
    });
  }
  const scenes = projects.filter((project) => project.counted).length;
  const sources = counted.validSources;
  const ratio = durationRatio(sources, counted.preferredSources, input.durationRule);
  const tier = reached(tiers, sources, scenes);
  const sourceTier = reached(tiers, sources, null);
  const top = tiers[tiers.length - 1];
  const extraScenes = tier && tier.tier === top.tier ? Math.max(0, scenes - top.sceneMin) : 0;
  const extraAmount = extraScenes * input.extraScenePrice;
  const tierPrice = tier?.price ?? 0;

  const warnings: PricingWarning[] = [];
  let next: NextTierHint | null = null;
  const nextTier = tier ? tiers.find((candidate) => candidate.tier > tier.tier) : tiers[0];
  if (nextTier) {
    const missingSources = Math.max(0, nextTier.sourceMin - sources);
    const missingScenes = Math.max(0, nextTier.sceneMin - scenes);
    next = {
      tier: nextTier.tier,
      missingSources,
      missingScenes,
      message: `Lên Mức ${nextTier.tier}: ${missingMessage(missingSources, missingScenes)}`,
    };
  }
  if (!tier) {
    warnings.push({
      code: 'BELOW_TIER_1',
      message: `Gói chưa đạt Mức ${tiers[0].tier}: ${missingMessage((next as NextTierHint).missingSources, (next as NextTierHint).missingScenes)}`,
    });
  }
  if (sourceTier && (!tier || sourceTier.tier > tier.tier)) {
    const missingScenes = sourceTier.sceneMin - scenes;
    warnings.push({
      code: 'SCENES_LIMIT_TIER',
      message: `Đủ source cho Mức ${sourceTier.tier} nhưng thiếu ${missingScenes} bối cảnh: thêm bối cảnh hoặc tách gói`,
    });
  }
  if (!ratio.met) {
    warnings.push({
      code: 'DURATION_RATIO',
      message: `Không đạt 80/20: ${counted.preferredSources}/${sources} source ≥ ${input.durationRule.preferredSeconds}s (${formatPercent(ratio.ratio as number)} < ${formatPercent(input.durationRule.preferredRatio)})`,
    });
  }
  if (unknownDuration > 0) {
    warnings.push({
      code: 'UNKNOWN_DURATION',
      message: `${unknownDuration} file chưa có thời lượng (chưa phân tích), chưa được tính là source`,
    });
  }
  if (input.mode === 'final' && projects.some((project) => project.reason === 'not_evaluated')) {
    warnings.push({ code: 'NOT_EVALUATED', message: 'Còn dự án chưa nghiệm thu xong' });
  }

  return {
    scenes,
    excludedScenes: projects.length - scenes,
    sources,
    preferredSources: counted.preferredSources,
    shortFiles: counted.shortFiles,
    unknownDuration,
    durationRatio: ratio.ratio,
    durationRuleMet: ratio.met,
    tier: tier?.tier ?? null,
    tierPrice,
    tierItemId: tier?.itemId ?? null,
    extraScenes,
    extraScenePrice: input.extraScenePrice,
    extraAmount,
    amount: tierPrice + extraAmount,
    sourceTier: sourceTier?.tier ?? null,
    projects,
    next,
    belowTier1: tier === null,
    warnings,
  };
}
