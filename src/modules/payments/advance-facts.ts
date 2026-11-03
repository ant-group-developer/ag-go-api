import type { EntityManager } from 'typeorm';
import type { AdvanceOffsetRule } from '../../database/entities/contract.entity';
import { ISSUED_ACCEPTANCE_STATUSES } from './payment-ledger';

export type ContractAdvanceFacts = {
  /** Agreed advance (contracts.advance_amount), for `proportional` and the advance check. */
  advanceAmount: number;
  advanceOffsetRule: AdvanceOffsetRule;
  advancesPaid: number;
  refunds: number;
  /** Imported contracts only (FR-C-11); 0 otherwise. */
  legacyAdvanceBalance: number;
  /** Offsets of the other records issued or later (final). */
  offsetsIssued: number;
  /** Offsets of the other records still prepared (draft / submitted / approved), reserved. */
  offsetsPending: number;
};

/**
 * Advance facts of a contract from the payments and acceptance records (BR-32): what was actually
 * paid and returned, and what the records other than `excludeAcceptanceId` offset.
 */
export async function loadAdvanceFacts(
  manager: EntityManager,
  contractId: string,
  excludeAcceptanceId: string | null = null,
): Promise<ContractAdvanceFacts> {
  const [row] = (await manager.query(
    `SELECT contract.advance_amount::bigint AS "advanceAmount",
            contract.advance_offset_rule AS "advanceOffsetRule",
            CASE WHEN contract.source = 'legacy_import'
                 THEN COALESCE(contract.legacy_advance_balance, 0) ELSE 0 END::bigint
              AS "legacyAdvanceBalance",
            (SELECT COALESCE(sum(amount) FILTER (WHERE kind = 'advance'), 0)::bigint
             FROM payments WHERE contract_id = contract.id AND status = 'recorded') AS "advancesPaid",
            (SELECT COALESCE(sum(amount) FILTER (WHERE kind = 'refund'), 0)::bigint
             FROM payments WHERE contract_id = contract.id AND status = 'recorded') AS "refunds",
            (SELECT COALESCE(sum(advance_offset_amount) FILTER (WHERE status = ANY($3::text[])), 0)::bigint
             FROM acceptance_records
             WHERE contract_id = contract.id AND ($2::uuid IS NULL OR id <> $2::uuid)) AS "offsetsIssued",
            (SELECT COALESCE(sum(advance_offset_amount)
                      FILTER (WHERE status IN ('draft', 'submitted', 'approved')), 0)::bigint
             FROM acceptance_records
             WHERE contract_id = contract.id AND ($2::uuid IS NULL OR id <> $2::uuid)) AS "offsetsPending"
     FROM contracts contract WHERE contract.id = $1`,
    [contractId, excludeAcceptanceId, [...ISSUED_ACCEPTANCE_STATUSES]],
  )) as Array<Record<string, string>>;
  return {
    advanceAmount: Number(row.advanceAmount),
    advanceOffsetRule: row.advanceOffsetRule as AdvanceOffsetRule,
    advancesPaid: Number(row.advancesPaid),
    refunds: Number(row.refunds),
    legacyAdvanceBalance: Number(row.legacyAdvanceBalance),
    offsetsIssued: Number(row.offsetsIssued),
    offsetsPending: Number(row.offsetsPending),
  };
}
