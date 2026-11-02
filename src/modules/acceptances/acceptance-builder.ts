import type { EntityManager } from 'typeorm';
import type { AcceptanceUnit, AcceptanceWarning } from '../../database/entities/acceptance.entity';
import type { PricingModel } from '../../database/entities/contract.entity';
import type { ContractTerms } from '../contracts/contract-terms';
import { pricePackage } from '../packages/package-pricing';
import {
  computePerSource,
  computePerTopic,
  computePerUnit,
  type PerProjectResult,
} from '../pricing-engine/per-project';
import type { RateCardItemData } from '../pricing-engine/rate-card';
import {
  contractOn,
  perSourceFacts,
  shotFacts,
  topicFacts,
  type ContractRow,
} from '../pricing-facts/pricing-facts';
import { CONTRACT_TIME_ZONE } from '../project-contracts/project-delivery';
import { findRateCardInForce } from '../rate-cards/rate-cards.service';

/**
 * Gathers and prices what an acceptance record of a contract covers for a period (BR-20, BR-10…
 * BR-17): evaluated packages and per-source projects for `package_tier`, delivered and evaluated
 * projects for the other models; never what a non-cancelled record already counts. Pure reading:
 * the service writes the result.
 */

export type BuiltSource = {
  projectId: string;
  packageId: string | null;
  counted: boolean;
  reason: string | null;
  message: string | null;
  quantity: number;
  metrics: Record<string, unknown>;
};

export type BuiltLine = {
  lineKey: string;
  productLabel: string;
  categoryId: string | null;
  packageId: string | null;
  level: string | null;
  rateCardItemId: string | null;
  unit: AcceptanceUnit;
  quantity: number;
  unitPrice: number;
  metrics: Record<string, unknown>;
  sources: BuiltSource[];
};

export type BuiltAcceptance = {
  contract: ContractRow;
  terms: ContractTerms & { appliedAmendments: number[] };
  pricingModel: PricingModel;
  rateCard: { id: string; code: string; version: number } | null;
  lines: BuiltLine[];
  /** Projects looked at but not on any line (not counted), kept for the trace. */
  uncounted: BuiltSource[];
  packageIds: string[];
  warnings: AcceptanceWarning[];
  termsSnapshot: Record<string, unknown>;
};

export type BuildInput = {
  contractId: string;
  periodEnd: string;
  excludedProjectIds: readonly string[];
  excludedPackageIds: readonly string[];
  /** The record being (re)built: what it holds itself is available to it. */
  acceptanceId: string | null;
};

/** End of `periodEnd` in Vietnam, as the bound of `delivered_at` / `evaluated_at` (exclusive). */
const PERIOD_END_BOUND = `(($2::date + 1)::timestamp AT TIME ZONE '${CONTRACT_TIME_ZONE}')`;

type CandidateProject = { id: string; categoryId: string | null; categoryName: string | null };

async function candidateProjects(
  manager: EntityManager,
  input: BuildInput,
): Promise<CandidateProject[]> {
  return (await manager.query(
    `SELECT project.id, project.category_id AS "categoryId", category.name AS "categoryName"
     FROM projects project
     LEFT JOIN categories category ON category.id = project.category_id
     WHERE project.contract_id = $1
       AND project.delivered_at < ${PERIOD_END_BOUND}
       AND project.evaluation_status IN ('completed', 'partially_completed')
       AND project.accepted_outside_at IS NULL
       AND project.package_id IS NULL
       AND NOT (project.id = ANY($3::uuid[]))
       AND NOT EXISTS (
         SELECT 1 FROM acceptance_item_sources source
         WHERE source.project_id = project.id AND source.is_active
           AND source.acceptance_id IS DISTINCT FROM $4::uuid
       )
     ORDER BY project.delivered_at ASC, project.id ASC`,
    [input.contractId, input.periodEnd, input.excludedProjectIds, input.acceptanceId],
  )) as CandidateProject[];
}

function groupByCategory(projects: readonly CandidateProject[]) {
  const groups = new Map<
    string,
    { categoryId: string | null; name: string | null; ids: string[] }
  >();
  for (const project of projects) {
    const key = project.categoryId ?? 'none';
    const group = groups.get(key) ?? {
      categoryId: project.categoryId,
      name: project.categoryName,
      ids: [],
    };
    group.ids.push(project.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Lines of a per-project model: one per category with something counted. */
function perProjectLines(
  result: PerProjectResult,
  group: { categoryId: string | null; name: string | null },
  line: { key: string; unit: AcceptanceUnit; label: string; rateCardItemId?: string | null },
  out: { lines: BuiltLine[]; uncounted: BuiltSource[] },
) {
  const sources = result.projects.map((project): BuiltSource => ({
    projectId: project.projectId,
    packageId: null,
    counted: project.counted,
    reason: project.reason,
    message: project.message,
    quantity: project.quantity,
    metrics: { excluded: project.excluded },
  }));
  if (result.quantity === 0) {
    out.uncounted.push(...sources);
    return;
  }
  out.lines.push({
    lineKey: `${line.key}:${group.categoryId ?? 'none'}`,
    productLabel: (group.name ?? line.label).slice(0, 200),
    categoryId: group.categoryId,
    packageId: null,
    level: null,
    rateCardItemId: line.rateCardItemId ?? null,
    unit: line.unit,
    quantity: result.quantity,
    unitPrice: result.unitPrice,
    metrics: {
      projects: result.projects.filter((project) => project.counted).length,
      excludedProjects: result.projects.filter((project) => !project.counted).length,
      warnings: result.warnings,
    },
    sources: sources.filter((source) => source.counted),
  });
  out.uncounted.push(...sources.filter((source) => !source.counted));
}

export async function buildAcceptance(
  manager: EntityManager,
  input: BuildInput,
): Promise<BuiltAcceptance> {
  const loaded = await contractOn(manager, input.contractId, input.periodEnd);
  if (!loaded) {
    throw new Error(`Contract ${input.contractId} not found`);
  }
  const { contract, terms } = loaded;
  const config = terms.pricing_config as Record<string, unknown>;
  const techSpec = terms.tech_spec as Record<string, unknown>;
  const warnings: AcceptanceWarning[] = [];
  const out = { lines: [] as BuiltLine[], uncounted: [] as BuiltSource[] };
  const packageIds: string[] = [];
  let rateCard: BuiltAcceptance['rateCard'] = null;

  if (terms.pricing_model === 'per_topic') {
    const projects = await candidateProjects(manager, input);
    const facts = await topicFacts(
      manager,
      projects.map((project) => project.id),
    );
    for (const group of groupByCategory(projects)) {
      const result = computePerTopic(
        {
          unitPrice: Number(config.unit_price),
          minTopicMinutes: Number(config.min_topic_minutes ?? techSpec.min_topic_minutes ?? 0),
          maxTopicMinutes: (config.max_topic_minutes as number | undefined) ?? null,
        },
        facts.filter((fact) => group.ids.includes(fact.projectId)),
      );
      warnings.push(...result.warnings);
      perProjectLines(result, group, { key: 'topic', unit: 'topic', label: 'Video chủ đề' }, out);
    }
  } else if (terms.pricing_model === 'per_unit') {
    const projects = await candidateProjects(manager, input);
    const minShotSeconds =
      (config.min_shot_seconds as number | undefined) ??
      (techSpec.min_shot_seconds as number | null | undefined) ??
      null;
    const facts = await shotFacts(
      manager,
      projects.map((project) => project.id),
      minShotSeconds,
    );
    const unit = config.unit === 'clip' ? 'clip' : 'shot';
    for (const group of groupByCategory(projects)) {
      const result = computePerUnit(
        {
          unit,
          unitPrice: Number(config.unit_price),
          maxShotsPerClip: (config.max_shots_per_clip as number | undefined) ?? null,
          minShotSeconds,
        },
        facts.filter((fact) => group.ids.includes(fact.projectId)),
      );
      perProjectLines(
        result,
        group,
        { key: unit, unit, label: unit === 'clip' ? 'Clip' : 'Shot' },
        out,
      );
    }
  } else {
    const code = config.rate_card_id as string;
    const level = config.level as string;
    const card = await findRateCardInForce(manager, code, input.periodEnd);
    if (!card) {
      warnings.push({
        code: 'RATE_CARD_NOT_IN_FORCE',
        message: `Không có bảng giá ${code} đã phát hành hiệu lực ngày ${input.periodEnd}`,
      });
    } else {
      rateCard = { id: card.id, code: card.code, version: card.version };
      await packageLines(manager, input, level, out, warnings, packageIds);
      await perSourceLines(manager, input, card.content.items, out);
      const [{ count }] = (await manager.query(
        `SELECT count(*)::int AS count FROM projects project
         WHERE project.contract_id = $1 AND project.package_id IS NULL
           AND project.delivered_at < ${PERIOD_END_BOUND}
           AND project.evaluation_status IN ('completed', 'partially_completed')
           AND project.accepted_outside_at IS NULL
           AND NOT (project.category_id = ANY($3::uuid[]))
           AND NOT EXISTS (SELECT 1 FROM acceptance_item_sources source
                           WHERE source.project_id = project.id AND source.is_active)`,
        [
          input.contractId,
          input.periodEnd,
          card.content.items
            .filter((item) => item.pricingType === 'per_source')
            .map((item) => item.categoryId),
        ],
      )) as Array<{ count: number }>;
      if (count > 0) {
        warnings.push({
          code: 'PROJECTS_WITHOUT_PACKAGE',
          message: `${count} dự án đã nghiệm thu chưa thuộc gói nào nên chưa được tính`,
        });
      }
    }
  }

  return {
    contract,
    terms,
    pricingModel: terms.pricing_model,
    rateCard,
    lines: out.lines,
    uncounted: out.uncounted,
    packageIds,
    warnings,
    termsSnapshot: {
      date: input.periodEnd,
      pricing_model: terms.pricing_model,
      pricing_config: terms.pricing_config,
      tech_spec: terms.tech_spec,
      cap_amount: terms.cap_amount,
      payment_term_business_days: terms.payment_term_business_days,
      applied_amendments: terms.appliedAmendments,
      rate_card: rateCard,
    },
  };
}

/** BR-13: one line per evaluated package (plus its extra scenes), priced on the period's last day. */
async function packageLines(
  manager: EntityManager,
  input: BuildInput,
  level: string,
  out: { lines: BuiltLine[]; uncounted: BuiltSource[] },
  warnings: AcceptanceWarning[],
  packageIds: string[],
) {
  const packages = (await manager.query(
    `SELECT package.id, package.code, package.name, package.contract_id AS "contractId",
            package.category_id AS "categoryId", category.name AS "categoryName",
            package.submitted_preview AS "submittedPreview"
     FROM product_packages package
     LEFT JOIN categories category ON category.id = package.category_id
     WHERE package.contract_id = $1 AND package.status = 'evaluated'
       AND package.evaluated_at < ${PERIOD_END_BOUND}
       AND (package.acceptance_id IS NULL OR package.acceptance_id = $4::uuid)
       AND NOT (package.id = ANY($3::uuid[]))
     ORDER BY package.evaluated_at ASC, package.code ASC`,
    [input.contractId, input.periodEnd, input.excludedPackageIds, input.acceptanceId],
  )) as Array<{
    id: string;
    code: string;
    name: string | null;
    contractId: string;
    categoryId: string;
    categoryName: string | null;
    submittedPreview: { tier?: number | null } | null;
  }>;
  for (const pkg of packages) {
    packageIds.push(pkg.id);
    const pricing = await pricePackage(manager, pkg, input.periodEnd, 'final');
    const label = `${pkg.categoryName ?? 'Gói'} – ${pkg.code}`;
    const sources = pricing.projects.map((project): BuiltSource => ({
      projectId: project.projectId,
      packageId: pkg.id,
      counted: project.counted,
      reason: project.reason,
      message: project.message,
      quantity: project.counted ? 1 : 0,
      metrics: {
        validSources: project.validSources,
        preferredSources: project.preferredSources,
        shortFiles: project.shortFiles,
        unknownDuration: project.unknownDuration,
      },
    }));
    const prefix = (message: string) => `${pkg.code}: ${message}`;
    for (const problem of pricing.problems) {
      warnings.push({ code: problem.code, message: prefix(problem.message), packageId: pkg.id });
    }
    const result = pricing.result;
    for (const warning of result?.warnings ?? []) {
      warnings.push({ code: warning.code, message: prefix(warning.message), packageId: pkg.id });
    }
    const submittedTier = pkg.submittedPreview?.tier ?? null;
    if (result && submittedTier !== null && (result.tier ?? 0) < submittedTier) {
      warnings.push({
        code: 'TIER_DROPPED',
        message: prefix(
          `tụt từ Mức ${submittedTier} khi gửi xuống ${result.tier === null ? 'dưới Mức 1' : `Mức ${result.tier}`} sau nghiệm thu`,
        ),
        packageId: pkg.id,
      });
    }
    out.lines.push({
      lineKey: `package:${pkg.id}`,
      productLabel: label.slice(0, 200),
      categoryId: pkg.categoryId,
      packageId: pkg.id,
      level,
      rateCardItemId: result?.tierItemId ?? null,
      unit: 'package',
      quantity: 1,
      unitPrice: result?.tierPrice ?? 0,
      metrics: {
        packageCode: pkg.code,
        packageName: pkg.name,
        sources: result?.sources ?? 0,
        scenes: result?.scenes ?? 0,
        excludedScenes: result?.excludedScenes ?? 0,
        tier: result?.tier ?? null,
        durationRatio: result?.durationRatio ?? null,
        durationRuleMet: result?.durationRuleMet ?? true,
        rateCardVersion: pricing.rateCard?.version ?? null,
      },
      sources: sources.filter((source) => source.counted),
    });
    if (result && result.extraScenes > 0) {
      out.lines.push({
        lineKey: `extra:${pkg.id}`,
        productLabel: `${label} – bối cảnh phát sinh`.slice(0, 200),
        categoryId: pkg.categoryId,
        packageId: pkg.id,
        level,
        rateCardItemId: null,
        unit: 'extra_scene',
        quantity: result.extraScenes,
        unitPrice: result.extraScenePrice,
        metrics: { packageCode: pkg.code, scenes: result.scenes },
        sources: [],
      });
    }
    out.uncounted.push(...sources.filter((source) => !source.counted));
  }
}

/** BR-16: Lái xe / Flycam projects straight on the record, one line per product. */
async function perSourceLines(
  manager: EntityManager,
  input: BuildInput,
  items: readonly RateCardItemData[],
  out: { lines: BuiltLine[]; uncounted: BuiltSource[] },
) {
  const perSource = items.filter((item) => item.pricingType === 'per_source');
  if (perSource.length === 0) {
    return;
  }
  const projects = (await candidateProjects(manager, input)).filter((project) =>
    perSource.some((item) => item.categoryId === project.categoryId),
  );
  for (const group of groupByCategory(projects)) {
    const item = perSource.find((candidate) => candidate.categoryId === group.categoryId)!;
    const minSeconds = item.minSourceSeconds ?? 0;
    const facts = await perSourceFacts(manager, group.ids, minSeconds);
    const result = computePerSource(
      { pricePerSource: item.price, minSourceSeconds: minSeconds },
      facts,
    );
    perProjectLines(
      result,
      group,
      { key: 'source', unit: 'source', label: 'Source', rateCardItemId: item.id ?? null },
      out,
    );
  }
}
