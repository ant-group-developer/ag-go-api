import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { IN_FLIGHT_STATUSES } from '../../database/entities/asset-analysis.entity';
import { MediaSpecCheckEntity } from '../../database/entities/media-spec-check.entity';
import { effectiveTerms, type ContractTerms } from '../contracts/contract-terms';
import { contractSummaries, specCheckCounts, type ContractSummary } from './contract-summaries';
import { contractDay } from './project-delivery';
import {
  checkMedia,
  mediaFacts,
  resolveCheckRules,
  specHash,
  summarizeProject,
  type CheckRules,
  type MediaFacts,
  type ProjectSpecSummary,
  type SpecFinding,
  type SpecLevel,
} from './spec-check';

/** Keeps each multi-row upsert well under Postgres' bind-parameter limit. */
const UPSERT_CHUNK = 500;

type ProjectRow = {
  id: string;
  ownerUserId: string;
  contractId: string | null;
  deliveredAt: Date | null;
  acceptedOutsideAt: Date | null;
};

type VideoRow = {
  projectMediaId: string;
  assetId: string;
  fileName: string;
  evaluationStatus: 'pending' | 'approved' | 'rejected';
  sourceMetadata: Record<string, unknown> | null;
  analysisId: string | null;
  durationMs: number | null;
  hasAudio: boolean | null;
  usable: boolean | null;
  quality: number | null;
  technical: Record<string, unknown> | null;
  media: Record<string, unknown> | null;
  usableReason: string | null;
  pendingAnalysisStatus: string | null;
  checkContractId: string | null;
  checkSpecHash: string | null;
  checkTermsDate: string | null;
  checkAnalysisId: string | null;
  checkResult: SpecLevel | null;
  checkFindings: SpecFinding[] | null;
  checkedAt: Date | null;
};

export type MediaSpecCheckView = {
  projectMediaId: string;
  assetId: string;
  fileName: string;
  evaluationStatus: 'pending' | 'approved' | 'rejected';
  result: SpecLevel;
  findings: SpecFinding[];
  analysisId: string | null;
  checkedAt: Date;
};

export type ProjectSpecChecks = {
  projectId: string;
  contract: ContractSummary | null;
  deliveredAt: Date | null;
  acceptedOutsideAt: Date | null;
  /** `checked`; `no_contract`: not linked; `accepted_outside`: accepted before AG Go, not checked. */
  state: 'checked' | 'no_contract' | 'accepted_outside';
  /** Day whose terms were applied: the delivery day, or today before delivery. */
  termsDate: string | null;
  appliedAmendments: number[];
  specHash: string | null;
  techSpec: Record<string, unknown> | null;
  rules: CheckRules | null;
  summary: ProjectSpecSummary | null;
  media: MediaSpecCheckView[];
};

/**
 * Runs and stores the technical checks of contract-linked projects (FR-T-02, FR-T-03, FR-T-05):
 * each video against the tech spec in force on the delivery day, read from its current analysis.
 * Stored results are reused while the rules, the terms day and the analysis are unchanged.
 */
@Injectable()
export class SpecChecksService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Checks again the stale videos of the project (every video with `force`) and returns them all. */
  async refreshProject(projectId: string, options: { force?: boolean } = {}) {
    return this.dataSource.transaction((manager) =>
      this.refreshInside(manager, projectId, options),
    );
  }

  /** Checks again every linked project showing this asset, once its analysis is completed. */
  async refreshAsset(assetId: string): Promise<number> {
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT media.project_id AS "projectId"
       FROM project_media media
       INNER JOIN projects project ON project.id = media.project_id
       WHERE media.asset_id = $1
         AND project.contract_id IS NOT NULL
         AND project.accepted_outside_at IS NULL`,
      [assetId],
    )) as Array<{ projectId: string }>;
    for (const row of rows) {
      await this.refreshProject(row.projectId);
    }
    return rows.length;
  }

  /** Stored results by project media (for the media list of the evaluation screen). */
  async resultsForMedia(projectMediaIds: string[]) {
    if (projectMediaIds.length === 0) {
      return new Map<string, MediaSpecCheckEntity>();
    }
    const rows = await this.dataSource
      .getRepository(MediaSpecCheckEntity)
      .createQueryBuilder('spec_check')
      .where('spec_check.project_media_id = ANY(:ids)', { ids: projectMediaIds })
      .getMany();
    return new Map(rows.map((row) => [row.projectMediaId, row]));
  }

  /** Stored results counted by project (for project lists). */
  countsForProjects(projectIds: string[]) {
    return specCheckCounts(this.dataSource.manager, projectIds);
  }

  contractSummaries(manager: EntityManager, contractIds: string[]) {
    return contractSummaries(manager, contractIds);
  }

  private async refreshInside(
    manager: EntityManager,
    projectId: string,
    options: { force?: boolean },
  ): Promise<ProjectSpecChecks | null> {
    const [project] = (await manager.query(
      `SELECT id, owner_user_id AS "ownerUserId", contract_id AS "contractId",
              delivered_at AS "deliveredAt", accepted_outside_at AS "acceptedOutsideAt"
       FROM projects WHERE id = $1
       FOR UPDATE`,
      [projectId],
    )) as ProjectRow[];
    if (!project) {
      return null;
    }
    const empty: ProjectSpecChecks = {
      projectId,
      contract: null,
      deliveredAt: project.deliveredAt,
      acceptedOutsideAt: project.acceptedOutsideAt,
      state: 'no_contract',
      termsDate: null,
      appliedAmendments: [],
      specHash: null,
      techSpec: null,
      rules: null,
      summary: null,
      media: [],
    };
    if (!project.contractId) {
      await manager.delete(MediaSpecCheckEntity, { projectId });
      return empty;
    }
    const contract = (await this.contractSummaries(manager, [project.contractId])).get(
      project.contractId,
    );
    if (project.acceptedOutsideAt) {
      // Accepted on paper before AG Go: not checked, never counted again (spec 15.3).
      await manager.delete(MediaSpecCheckEntity, { projectId });
      return { ...empty, contract: contract ?? null, state: 'accepted_outside' };
    }
    // A check before delivery uses today's terms; it is redone with the delivery day's after.
    const termsDate = contractDay(project.deliveredAt ?? new Date());
    const terms = await this.termsOn(manager, project.contractId, termsDate);
    const rules = resolveCheckRules(terms);
    const hash = specHash(rules);

    await manager.query(
      `DELETE FROM media_spec_checks WHERE project_id = $1 AND contract_id <> $2`,
      [projectId, project.contractId],
    );
    const videos = await this.videos(manager, projectId);
    const media: MediaSpecCheckView[] = [];
    const forSummary: Array<{
      evaluationStatus: VideoRow['evaluationStatus'];
      result: SpecLevel;
      facts: MediaFacts;
    }> = [];
    const toStore: Array<Partial<MediaSpecCheckEntity>> = [];
    const now = new Date();
    for (const video of videos) {
      const facts = mediaFacts(video);
      const stale =
        options.force === true ||
        video.checkResult === null ||
        video.checkResult === 'unknown' ||
        video.checkContractId !== project.contractId ||
        video.checkSpecHash !== hash ||
        video.checkTermsDate !== termsDate ||
        (video.checkAnalysisId ?? null) !== (video.analysisId ?? null);
      let result: SpecLevel;
      let findings: SpecFinding[];
      let checkedAt: Date;
      if (stale) {
        ({ result, findings } = checkMedia(rules, facts));
        checkedAt = now;
        toStore.push({
          projectMediaId: video.projectMediaId,
          projectId,
          contractId: project.contractId,
          specHash: hash,
          termsDate,
          analysisId: video.analysisId,
          result,
          findings: findings as unknown as Array<Record<string, unknown>>,
          checkedAt,
        });
      } else {
        result = video.checkResult!;
        findings = video.checkFindings ?? [];
        checkedAt = video.checkedAt ?? now;
      }
      media.push({
        projectMediaId: video.projectMediaId,
        assetId: video.assetId,
        fileName: video.fileName,
        evaluationStatus: video.evaluationStatus,
        result,
        findings,
        analysisId: video.analysisId,
        checkedAt,
      });
      forSummary.push({ evaluationStatus: video.evaluationStatus, result, facts });
    }
    for (let start = 0; start < toStore.length; start += UPSERT_CHUNK) {
      await manager.upsert(
        MediaSpecCheckEntity,
        toStore.slice(
          start,
          start + UPSERT_CHUNK,
        ) as QueryDeepPartialEntity<MediaSpecCheckEntity>[],
        ['projectMediaId'],
      );
    }
    return {
      ...empty,
      contract: contract ?? null,
      state: 'checked',
      termsDate,
      appliedAmendments: terms.appliedAmendments,
      specHash: hash,
      techSpec: terms.tech_spec,
      rules,
      summary: summarizeProject(rules, forSummary),
      media,
    };
  }

  /** Terms of the contract in force on `day` (signed amendments applied, as GET /contracts/:id/terms). */
  private async termsOn(manager: EntityManager, contractId: string, day: string) {
    const [contract] = (await manager.query(
      `SELECT pricing_model, pricing_config, cap_amount, tech_spec, end_date::text AS end_date,
              payment_term_business_days, penalty_percent
       FROM contracts WHERE id = $1`,
      [contractId],
    )) as Array<ContractTerms & { cap_amount: string | null; penalty_percent: string }>;
    const amendments = (await manager.query(
      `SELECT amendment_number AS "amendmentNumber", effective_date::text AS "effectiveDate",
              status, changes
       FROM contract_amendments
       WHERE contract_id = $1 AND status = 'signed'`,
      [contractId],
    )) as Array<{
      amendmentNumber: number;
      effectiveDate: string;
      status: string;
      changes: Record<string, unknown>;
    }>;
    return effectiveTerms(
      {
        ...contract,
        cap_amount: contract.cap_amount === null ? null : Number(contract.cap_amount),
        penalty_percent: Number(contract.penalty_percent),
      },
      amendments,
      day,
    );
  }

  private async videos(manager: EntityManager, projectId: string): Promise<VideoRow[]> {
    return (await manager.query(
      `SELECT media.id AS "projectMediaId", media.asset_id AS "assetId",
              asset.original_filename AS "fileName", media.evaluation_status AS "evaluationStatus",
              asset.source_metadata AS "sourceMetadata",
              analysis.id AS "analysisId", analysis.duration_ms AS "durationMs",
              analysis.has_audio AS "hasAudio", analysis.usable, analysis.quality,
              analysis.technical, analysis.artifacts -> 'media' AS media,
              analysis.description ->> 'usable_reason' AS "usableReason",
              (SELECT running.status FROM asset_analyses running
               WHERE running.asset_id = media.asset_id AND running.status = ANY($2::varchar[])
               ORDER BY running.created_at DESC LIMIT 1) AS "pendingAnalysisStatus",
              spec_check.contract_id AS "checkContractId", spec_check.spec_hash AS "checkSpecHash",
              spec_check.terms_date::text AS "checkTermsDate",
              spec_check.analysis_id AS "checkAnalysisId", spec_check.result AS "checkResult",
              spec_check.findings AS "checkFindings", spec_check.checked_at AS "checkedAt"
       FROM project_media media
       INNER JOIN assets asset ON asset.id = media.asset_id
       LEFT JOIN asset_analyses analysis
         ON analysis.asset_id = media.asset_id AND analysis.is_current = true
       LEFT JOIN media_spec_checks spec_check ON spec_check.project_media_id = media.id
       WHERE media.project_id = $1 AND asset.asset_type = 'video'
       ORDER BY media.sort_order ASC, media.id ASC`,
      [projectId, IN_FLIGHT_STATUSES],
    )) as VideoRow[];
  }
}
