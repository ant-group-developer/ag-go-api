import type { AcceptanceStatus } from '../../database/entities/acceptance.entity';

/**
 * Acceptance record state machine (spec 5.3). Payment statuses (`partially_paid`, `paid`) come
 * with the payments phase.
 *
 *   draft → submitted (submit) → approved (approve) → issued (issue: appendix number, locked)
 *   submitted → draft (return, with a reason)
 *   issued → signed (sign: signed copy, due date)
 *   draft | submitted | approved | issued → cancelled (cancel, with a reason; the number of an
 *   issued record is not reused)
 */
export const ACCEPTANCE_TRANSITIONS = {
  submit: { from: ['draft'], to: 'submitted' },
  return: { from: ['submitted'], to: 'draft' },
  approve: { from: ['submitted'], to: 'approved' },
  issue: { from: ['approved'], to: 'issued' },
  sign: { from: ['issued'], to: 'signed' },
  cancel: { from: ['draft', 'submitted', 'approved', 'issued'], to: 'cancelled' },
} as const satisfies Record<string, { from: readonly AcceptanceStatus[]; to: AcceptanceStatus }>;

export type AcceptanceAction = keyof typeof ACCEPTANCE_TRANSITIONS;
export const ACCEPTANCE_ACTIONS = Object.keys(ACCEPTANCE_TRANSITIONS) as AcceptanceAction[];

/** Permission level an action needs: `prepare` (go.acceptance.prepare) or `approve`. */
export function actionLevel(
  action: AcceptanceAction,
  status: AcceptanceStatus,
): 'prepare' | 'approve' {
  if (action === 'submit') {
    return 'prepare';
  }
  if (action === 'cancel') {
    return status === 'draft' || status === 'submitted' ? 'prepare' : 'approve';
  }
  return 'approve';
}

export class AcceptanceTransitionError extends Error {
  constructor(
    readonly status: AcceptanceStatus,
    readonly action: AcceptanceAction,
  ) {
    super(`Cannot ${action} an acceptance record in status ${status}`);
  }
}

export function canTransitionAcceptance(status: AcceptanceStatus, action: AcceptanceAction) {
  return (ACCEPTANCE_TRANSITIONS[action].from as readonly AcceptanceStatus[]).includes(status);
}

export function nextAcceptanceStatus(
  status: AcceptanceStatus,
  action: AcceptanceAction,
): AcceptanceStatus {
  if (!canTransitionAcceptance(status, action)) {
    throw new AcceptanceTransitionError(status, action);
  }
  return ACCEPTANCE_TRANSITIONS[action].to;
}

/** Lines, period and amounts change only on a draft; from `issued` on the content is locked. */
export function acceptanceEditable(status: AcceptanceStatus): boolean {
  return status === 'draft';
}
