import type { ContractStatus } from '../../database/entities/contract.entity';

/**
 * Contract state machine (spec 5.2):
 *
 *   draft → issued (issue) → active (activate) ⇄ suspended (suspend / resume)
 *   issued → draft (unissue, to edit again)
 *   active → completed (complete); active | suspended → terminated (terminate)
 *
 * Only `active` contracts take new projects and acceptance records; `completed` and `terminated`
 * are final.
 */
export const CONTRACT_TRANSITIONS = {
  issue: { from: ['draft'], to: 'issued' },
  unissue: { from: ['issued'], to: 'draft' },
  activate: { from: ['issued'], to: 'active' },
  suspend: { from: ['active'], to: 'suspended' },
  resume: { from: ['suspended'], to: 'active' },
  complete: { from: ['active'], to: 'completed' },
  terminate: { from: ['active', 'suspended'], to: 'terminated' },
} as const satisfies Record<string, { from: readonly ContractStatus[]; to: ContractStatus }>;

export type ContractAction = keyof typeof CONTRACT_TRANSITIONS;

export const CONTRACT_ACTIONS = Object.keys(CONTRACT_TRANSITIONS) as ContractAction[];

export class ContractTransitionError extends Error {
  constructor(
    readonly status: ContractStatus,
    readonly action: ContractAction,
  ) {
    super(`Cannot ${action} a contract in status ${status}`);
  }
}

export function canTransition(status: ContractStatus, action: ContractAction): boolean {
  return (CONTRACT_TRANSITIONS[action].from as readonly ContractStatus[]).includes(status);
}

/** Status after `action`; throws ContractTransitionError when not allowed from `status`. */
export function nextContractStatus(status: ContractStatus, action: ContractAction): ContractStatus {
  if (!canTransition(status, action)) {
    throw new ContractTransitionError(status, action);
  }
  return CONTRACT_TRANSITIONS[action].to;
}

/** Actions possible from `status`, for the client to show its buttons. */
export function allowedContractActions(status: ContractStatus): ContractAction[] {
  return CONTRACT_ACTIONS.filter((action) => canTransition(status, action));
}

/** Terms (pricing, ceiling, tech spec…) are edited directly only before issue; later by amendment. */
export function termsEditable(status: ContractStatus): boolean {
  return status === 'draft';
}

/** Amendments change the terms of a running contract. */
export function amendable(status: ContractStatus): boolean {
  return status === 'active' || status === 'suspended';
}
