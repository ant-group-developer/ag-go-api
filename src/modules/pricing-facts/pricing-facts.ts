import type { EntityManager } from 'typeorm';
import {
  effectiveTerms,
  type ContractTerms,
  type SignedAmendment,
} from '../contracts/contract-terms';
import type { DurationRule } from '../pricing-engine/durations';
import type { PackageProjectFacts } from '../pricing-engine/package-tier';
import type {
  PerSourceProjectFacts,
  ShotProjectFacts,
  TopicProjectFacts,
} from '../pricing-engine/per-project';

/**
 * Per-project counts the pricing engine needs, aggregated in SQL (NFR-01: one grouped query per
 * call, no loop over media in the application). Durations come from the current analysis
 * (`asset_analyses.duration_ms`), else the probed `durationSeconds` of the upload.
 */

/** Seconds of a video, null when unknown. */
const SECONDS = `CASE
  WHEN analysis.duration_ms IS NOT NULL THEN analysis.duration_ms / 1000.0
  WHEN asset.source_metadata ->> 'durationSeconds' ~ '^[0-9]+(\\.[0-9]+)?$'
    THEN (asset.source_metadata ->> 'durationSeconds')::numeric
END`;

/** One row per video of the projects ($1), with its evaluation status and seconds. */
const VIDEOS = `
  SELECT media.id AS media_id, media.project_id, media.evaluation_status AS status, ${SECONDS} AS seconds
  FROM project_media media
  INNER JOIN assets asset ON asset.id = media.asset_id AND asset.asset_type = 'video'
  LEFT JOIN asset_analyses analysis ON analysis.asset_id = media.asset_id AND analysis.is_current = true
  WHERE media.project_id = ANY($1::uuid[])`;

/** Evaluation finished: a final project status and no media left pending. */
export const EVALUATED_STATUSES = ['completed', 'partially_completed', 'failed'] as const;

export type ProjectNameRow = { projectId: string; name: string; evaluationStatus: string };

function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * BR-13 / BR-17 counts of package projects. `provisional` counts pending videos as if approved
 * (preview of an open / submitted package); otherwise only approved videos count.
 */
export async function packageProjectFacts(
  manager: EntityManager,
  projectIds: readonly string[],
  rule: DurationRule,
  provisional: boolean,
): Promise<Array<PackageProjectFacts & ProjectNameRow & { pendingMedia: number }>> {
  if (projectIds.length === 0) {
    return [];
  }
  const rows = (await manager.query(
    `WITH videos AS (${VIDEOS}),
     candidates AS (
       SELECT * FROM videos WHERE status = 'approved' OR ($4::boolean AND status = 'pending')
     ),
     pending AS (
       SELECT project_id, count(*) AS pending FROM project_media
       WHERE project_id = ANY($1::uuid[]) AND evaluation_status = 'pending' GROUP BY project_id
     )
     SELECT project.id AS "projectId", project.name, project.evaluation_status AS "evaluationStatus",
            COALESCE(pending.pending, 0) AS "pendingMedia",
            count(candidate.media_id) AS files,
            count(candidate.media_id) FILTER (WHERE candidate.seconds IS NULL) AS "unknownDuration",
            count(candidate.media_id) FILTER (WHERE candidate.seconds < $2) AS "shortFiles",
            count(candidate.media_id) FILTER (WHERE candidate.seconds >= $2) AS "validSources",
            count(candidate.media_id) FILTER (WHERE candidate.seconds >= $3) AS "preferredSources"
     FROM projects project
     LEFT JOIN candidates candidate ON candidate.project_id = project.id
     LEFT JOIN pending ON pending.project_id = project.id
     WHERE project.id = ANY($1::uuid[])
     GROUP BY project.id, pending.pending
     ORDER BY project.name ASC, project.id ASC`,
    [projectIds, rule.minSeconds, rule.preferredSeconds, provisional],
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const pendingMedia = toNumber(row.pendingMedia);
    return {
      projectId: row.projectId as string,
      name: row.name as string,
      evaluationStatus: row.evaluationStatus as string,
      pendingMedia,
      evaluated:
        pendingMedia === 0 &&
        (EVALUATED_STATUSES as readonly string[]).includes(row.evaluationStatus as string),
      files: toNumber(row.files),
      unknownDuration: toNumber(row.unknownDuration),
      shortFiles: toNumber(row.shortFiles),
      validSources: toNumber(row.validSources),
      preferredSources: toNumber(row.preferredSources),
    };
  });
}

/** BR-10: approved minutes and pending media of `per_topic` projects. */
export async function topicFacts(
  manager: EntityManager,
  projectIds: readonly string[],
): Promise<TopicProjectFacts[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const rows = (await manager.query(
    `WITH videos AS (${VIDEOS}),
     pending AS (
       SELECT project_id, count(*) AS pending FROM project_media
       WHERE project_id = ANY($1::uuid[]) AND evaluation_status = 'pending' GROUP BY project_id
     )
     SELECT project.id AS "projectId",
            COALESCE(sum(video.seconds) FILTER (WHERE video.status = 'approved'), 0) AS "approvedSeconds",
            count(video.media_id) FILTER (WHERE video.status = 'approved' AND video.seconds IS NULL)
              AS "unknownDuration",
            COALESCE(pending.pending, 0) AS "pendingMedia"
     FROM projects project
     LEFT JOIN videos video ON video.project_id = project.id
     LEFT JOIN pending ON pending.project_id = project.id
     WHERE project.id = ANY($1::uuid[])
     GROUP BY project.id, pending.pending`,
    [projectIds],
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    projectId: row.projectId as string,
    approvedSeconds: Math.floor(toNumber(row.approvedSeconds)),
    unknownDuration: toNumber(row.unknownDuration),
    pendingMedia: toNumber(row.pendingMedia),
  }));
}

/**
 * BR-11: approved videos of `per_unit` projects by category, in the order of `countShots`: unknown
 * duration (when a minimum applies), shorter than the minimum, technical `fail` approved without a
 * reason (latest evaluation comment empty, FR-T-04), else a shot.
 */
export async function shotFacts(
  manager: EntityManager,
  projectIds: readonly string[],
  minShotSeconds: number | null,
): Promise<ShotProjectFacts[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const rows = (await manager.query(
    `WITH videos AS (${VIDEOS}),
     classified AS (
       SELECT video.project_id,
              CASE
                WHEN $2::numeric IS NOT NULL AND video.seconds IS NULL THEN 'unknown'
                WHEN $2::numeric IS NOT NULL AND video.seconds < $2::numeric THEN 'short'
                WHEN spec_check.result = 'fail' AND COALESCE(trim(
                  (SELECT evaluation.comment FROM project_media_evaluations evaluation
                   WHERE evaluation.project_media_id = video.media_id
                   ORDER BY evaluation.created_at DESC LIMIT 1)), '') = '' THEN 'spec_fail'
                ELSE 'shot'
              END AS kind
       FROM videos video
       INNER JOIN projects project ON project.id = video.project_id
       LEFT JOIN media_spec_checks spec_check
         ON spec_check.project_media_id = video.media_id AND spec_check.contract_id = project.contract_id
       WHERE video.status = 'approved'
     )
     SELECT project.id AS "projectId",
            count(*) FILTER (WHERE classified.kind = 'shot') AS shots,
            count(*) FILTER (WHERE classified.kind = 'short') AS "belowMinDuration",
            count(*) FILTER (WHERE classified.kind = 'unknown') AS "unknownDuration",
            count(*) FILTER (WHERE classified.kind = 'spec_fail') AS "specFail"
     FROM projects project
     LEFT JOIN classified ON classified.project_id = project.id
     WHERE project.id = ANY($1::uuid[])
     GROUP BY project.id`,
    [projectIds, minShotSeconds],
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    projectId: row.projectId as string,
    shots: toNumber(row.shots),
    belowMinDuration: toNumber(row.belowMinDuration),
    unknownDuration: toNumber(row.unknownDuration),
    specFail: toNumber(row.specFail),
  }));
}

/** BR-16: approved videos of per-source projects (Lái xe / Flycam) against the minimum. */
export async function perSourceFacts(
  manager: EntityManager,
  projectIds: readonly string[],
  minSourceSeconds: number,
): Promise<PerSourceProjectFacts[]> {
  if (projectIds.length === 0) {
    return [];
  }
  const rows = (await manager.query(
    `WITH videos AS (${VIDEOS})
     SELECT project.id AS "projectId",
            count(video.media_id) FILTER (WHERE video.seconds >= $2) AS sources,
            count(video.media_id) FILTER (WHERE video.seconds < $2) AS "belowMinDuration",
            count(video.media_id) FILTER (WHERE video.media_id IS NOT NULL AND video.seconds IS NULL)
              AS "unknownDuration"
     FROM projects project
     LEFT JOIN videos video ON video.project_id = project.id AND video.status = 'approved'
     WHERE project.id = ANY($1::uuid[])
     GROUP BY project.id`,
    [projectIds, minSourceSeconds],
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    projectId: row.projectId as string,
    sources: toNumber(row.sources),
    belowMinDuration: toNumber(row.belowMinDuration),
    unknownDuration: toNumber(row.unknownDuration),
  }));
}

export type ContractRow = {
  id: string;
  partnerId: string;
  contractNumber: string;
  status: string;
  managerUserId: string;
  startDate: string;
  endDate: string | null;
  advanceAmount: number;
  advanceOffsetRule: 'full_first' | 'proportional';
  legacyAcceptedAmount: number | null;
  legacyAdvanceBalance: number | null;
  source: string;
  lastAppendixNumber: number;
  paymentTermBusinessDays: number;
};

/** Terms in force on `day` (signed amendments applied, spec 7.3) and the contract columns used. */
export async function contractOn(
  manager: EntityManager,
  contractId: string,
  day: string,
): Promise<{
  contract: ContractRow;
  terms: ContractTerms & { appliedAmendments: number[] };
} | null> {
  const [row] = (await manager.query(
    `SELECT id, partner_id AS "partnerId", contract_number AS "contractNumber", status,
            manager_user_id AS "managerUserId", start_date::text AS "startDate",
            end_date::text AS "endDate", advance_amount::bigint AS "advanceAmount",
            advance_offset_rule AS "advanceOffsetRule",
            legacy_accepted_amount AS "legacyAcceptedAmount",
            legacy_advance_balance AS "legacyAdvanceBalance", source,
            last_appendix_number AS "lastAppendixNumber",
            payment_term_business_days AS "paymentTermBusinessDays",
            pricing_model, pricing_config, cap_amount, tech_spec,
            end_date::text AS end_date, payment_term_business_days, penalty_percent
     FROM contracts WHERE id = $1`,
    [contractId],
  )) as Array<Record<string, unknown>>;
  if (!row) {
    return null;
  }
  const amendments = (await manager.query(
    `SELECT amendment_number AS "amendmentNumber", effective_date::text AS "effectiveDate",
            status, changes
     FROM contract_amendments WHERE contract_id = $1 AND status = 'signed'`,
    [contractId],
  )) as SignedAmendment[];
  const nullableNumber = (value: unknown) => (value === null ? null : Number(value));
  return {
    contract: {
      id: row.id as string,
      partnerId: row.partnerId as string,
      contractNumber: row.contractNumber as string,
      status: row.status as string,
      managerUserId: row.managerUserId as string,
      startDate: row.startDate as string,
      endDate: row.endDate as string | null,
      advanceAmount: Number(row.advanceAmount),
      advanceOffsetRule: row.advanceOffsetRule as ContractRow['advanceOffsetRule'],
      legacyAcceptedAmount: nullableNumber(row.legacyAcceptedAmount),
      legacyAdvanceBalance: nullableNumber(row.legacyAdvanceBalance),
      source: row.source as string,
      lastAppendixNumber: Number(row.lastAppendixNumber),
      paymentTermBusinessDays: Number(row.paymentTermBusinessDays),
    },
    terms: effectiveTerms(
      {
        pricing_model: row.pricing_model as ContractTerms['pricing_model'],
        pricing_config: row.pricing_config as Record<string, unknown>,
        cap_amount: nullableNumber(row.cap_amount),
        tech_spec: row.tech_spec as Record<string, unknown>,
        end_date: row.end_date as string | null,
        payment_term_business_days: Number(row.payment_term_business_days),
        penalty_percent: Number(row.penalty_percent),
      },
      amendments,
      day,
    ),
  };
}
