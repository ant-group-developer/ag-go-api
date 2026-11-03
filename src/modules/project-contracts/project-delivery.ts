import type { EntityManager } from 'typeorm';
import { createOutboxEvent } from '../../common/outbox.service';
import { ProjectAuditLogEntity } from '../../database/entities/project-audit-log.entity';
import { PROJECT_SPEC_CHECKS_REQUESTED_EVENT } from './project-contracts.events';

/** Contract days (start / end, delivery day, terms day) are Vietnamese calendar days. */
export const CONTRACT_TIME_ZONE = 'Asia/Ho_Chi_Minh';

/** Actor of the links AG Go makes by itself, in the project audit log. */
export const SYSTEM_ACTOR = 'system';

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CONTRACT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** YYYY-MM-DD of `date` in Vietnam. */
export function contractDay(date: Date): string {
  return DAY_FORMAT.format(date);
}

export type ContractInForce = { id: string; contractNumber: string; startDate: string };

/**
 * Active contracts of the partner who owns the project (`partners.go_user_id = owner_user_id`,
 * Q1) in force on `day`: started, not ended, the partner itself active (FR-P-09, FR-C-08).
 */
export async function contractsInForce(
  manager: EntityManager,
  ownerUserId: string,
  day: string,
): Promise<ContractInForce[]> {
  return (await manager.query(
    `SELECT contract.id, contract.contract_number AS "contractNumber",
            contract.start_date::text AS "startDate"
     FROM contracts contract
     INNER JOIN partners partner ON partner.id = contract.partner_id
     WHERE partner.go_user_id = $1
       AND partner.status = 'active'
       AND contract.status = 'active'
       AND contract.start_date <= $2::date
       AND (contract.end_date IS NULL OR contract.end_date >= $2::date)
     ORDER BY contract.start_date DESC, contract.contract_number ASC`,
    [ownerUserId, day],
  )) as ContractInForce[];
}

/** Rows of an `UPDATE ... RETURNING` (the Postgres driver answers `[rows, affected]`). */
function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

export function requestSpecChecks(manager: EntityManager, projectId: string) {
  return manager.save(
    createOutboxEvent(manager, {
      eventType: PROJECT_SPEC_CHECKS_REQUESTED_EVENT,
      aggregateType: 'project',
      aggregateId: projectId,
      payload: { projectId },
    }),
  );
}

export type AutoLinkResult = {
  contractId: string | null;
  /** Contracts in force; more than one leaves the choice to the partner's manager. */
  candidateCount: number;
};

/**
 * Links the project to its owner's contract in force on `day` when there is exactly one
 * (FR-P-09); with none or several the project stays unlinked for the manager to choose. Never
 * replaces a link nor touches a project accepted outside AG Go. Recorded in the project log as done
 * by `system`; `requestChecks` also queues its technical checks.
 */
export async function autoLinkProject(
  manager: EntityManager,
  project: { id: string; ownerUserId: string },
  day: string,
  options: { requestChecks: boolean },
): Promise<AutoLinkResult> {
  const candidates = await contractsInForce(manager, project.ownerUserId, day);
  if (candidates.length !== 1) {
    return { contractId: null, candidateCount: candidates.length };
  }
  const [contract] = candidates;
  const linked = returnedRows<{ id: string }>(
    await manager.query(
      `UPDATE projects SET contract_id = $2, updated_at = now()
       WHERE id = $1 AND contract_id IS NULL AND accepted_outside_at IS NULL
       RETURNING id`,
      [project.id, contract.id],
    ),
  );
  if (linked.length === 0) {
    return { contractId: null, candidateCount: candidates.length };
  }
  await manager.insert(ProjectAuditLogEntity, {
    projectId: project.id,
    actorUserId: SYSTEM_ACTOR,
    action: 'contract_linked',
    afterData: { contractId: contract.id, contractNumber: contract.contractNumber },
    metadata: { source: 'auto', day },
  });
  if (options.requestChecks) {
    await requestSpecChecks(manager, project.id);
  }
  return { contractId: contract.id, candidateCount: 1 };
}

/**
 * Called whenever a project's evaluation status is recalculated: the first time it is `pending`
 * the project counts as delivered (`delivered_at`, spec 7.4). A delivered project is linked to its
 * owner's only contract in force on that day if it has no contract yet, and the technical checks of
 * a linked one are queued. Later passes through `pending` change nothing.
 */
export async function recordProjectDelivery(
  manager: EntityManager,
  projectId: string,
  evaluationStatus: string,
): Promise<void> {
  if (evaluationStatus !== 'pending') {
    return;
  }
  const [delivered] = returnedRows<{
    ownerUserId: string;
    contractId: string | null;
    acceptedOutsideAt: Date | null;
    deliveredAt: Date;
  }>(
    await manager.query(
      `UPDATE projects SET delivered_at = now()
       WHERE id = $1 AND delivered_at IS NULL
       RETURNING owner_user_id AS "ownerUserId", contract_id AS "contractId",
                 accepted_outside_at AS "acceptedOutsideAt", delivered_at AS "deliveredAt"`,
      [projectId],
    ),
  );
  if (!delivered || delivered.acceptedOutsideAt) {
    return;
  }
  if (delivered.contractId) {
    await requestSpecChecks(manager, projectId);
    return;
  }
  await autoLinkProject(
    manager,
    { id: projectId, ownerUserId: delivered.ownerUserId },
    contractDay(new Date(delivered.deliveredAt)),
    { requestChecks: true },
  );
}
