import type { EntityManager } from 'typeorm';
import type { PricingModel } from '../../database/entities/contract.entity';
import type { SpecLevel } from './spec-check';

/** What project screens show of a linked contract: no money terms. */
export type ContractSummary = {
  id: string;
  contractNumber: string;
  status: string;
  pricingModel: PricingModel;
  startDate: string;
  endDate: string | null;
  managerUserId: string;
  partner: { id: string; code: string; displayName: string };
};

export async function contractSummaries(
  manager: EntityManager,
  contractIds: string[],
): Promise<Map<string, ContractSummary>> {
  const unique = [...new Set(contractIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = (await manager.query(
    `SELECT contract.id, contract.contract_number AS "contractNumber", contract.status,
            contract.pricing_model AS "pricingModel", contract.start_date::text AS "startDate",
            contract.end_date::text AS "endDate", contract.manager_user_id AS "managerUserId",
            json_build_object('id', partner.id, 'code', partner.code,
                              'displayName', partner.display_name) AS partner
     FROM contracts contract
     INNER JOIN partners partner ON partner.id = contract.partner_id
     WHERE contract.id = ANY($1::uuid[])`,
    [unique],
  )) as ContractSummary[];
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Stored check results by project, under each project's current contract and leaving out rejected
 * videos (they are never paid).
 */
export async function specCheckCounts(
  manager: EntityManager,
  projectIds: string[],
): Promise<Map<string, Record<SpecLevel, number>>> {
  const counts = new Map<string, Record<SpecLevel, number>>();
  if (projectIds.length === 0) {
    return counts;
  }
  const rows = (await manager.query(
    `SELECT spec_check.project_id AS "projectId", spec_check.result, count(*)::int AS count
     FROM media_spec_checks spec_check
     INNER JOIN projects project
       ON project.id = spec_check.project_id AND project.contract_id = spec_check.contract_id
     INNER JOIN project_media media ON media.id = spec_check.project_media_id
     WHERE spec_check.project_id = ANY($1::uuid[]) AND media.evaluation_status <> 'rejected'
     GROUP BY spec_check.project_id, spec_check.result`,
    [projectIds],
  )) as Array<{ projectId: string; result: SpecLevel; count: number }>;
  for (const row of rows) {
    const entry = counts.get(row.projectId) ?? { pass: 0, warn: 0, fail: 0, unknown: 0 };
    entry[row.result] = Number(row.count);
    counts.set(row.projectId, entry);
  }
  return counts;
}
