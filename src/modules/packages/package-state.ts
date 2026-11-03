import type { PackageStatus } from '../../database/entities/product-package.entity';

/**
 * Package state machine (spec 7.4.1):
 *
 *   open → submitted (submit, needs ≥ tier 1 on the provisional computation)
 *   submitted → open (withdraw by the partner / manager, return by the evaluator)
 *   submitted → evaluated (system: every project evaluated, FR-K-06)
 *   evaluated → submitted (system: a project went back to pending)
 *   evaluated → open (reopen, or return by the evaluator)
 *   evaluated → accepted (system: issued on an acceptance record); accepted → evaluated (cancelled)
 *   open → cancelled
 *
 * Only `open` packages change their projects.
 */
export const PACKAGE_TRANSITIONS = {
  submit: { from: ['open'], to: 'submitted' },
  withdraw: { from: ['submitted'], to: 'open' },
  return: { from: ['submitted', 'evaluated'], to: 'open' },
  evaluate: { from: ['submitted'], to: 'evaluated' },
  unevaluate: { from: ['evaluated'], to: 'submitted' },
  reopen: { from: ['evaluated'], to: 'open' },
  accept: { from: ['evaluated'], to: 'accepted' },
  unaccept: { from: ['accepted'], to: 'evaluated' },
  cancel: { from: ['open'], to: 'cancelled' },
} as const satisfies Record<string, { from: readonly PackageStatus[]; to: PackageStatus }>;

export type PackageAction = keyof typeof PACKAGE_TRANSITIONS;

/** Actions a user may ask for (the others are done by the system). */
export const USER_PACKAGE_ACTIONS = ['submit', 'withdraw', 'return', 'reopen', 'cancel'] as const;
export type UserPackageAction = (typeof USER_PACKAGE_ACTIONS)[number];

export function canTransitionPackage(status: PackageStatus, action: PackageAction): boolean {
  return (PACKAGE_TRANSITIONS[action].from as readonly PackageStatus[]).includes(status);
}

export class PackageTransitionError extends Error {
  constructor(
    readonly status: PackageStatus,
    readonly action: PackageAction,
  ) {
    super(`Cannot ${action} a package in status ${status}`);
  }
}

export function nextPackageStatus(status: PackageStatus, action: PackageAction): PackageStatus {
  if (!canTransitionPackage(status, action)) {
    throw new PackageTransitionError(status, action);
  }
  return PACKAGE_TRANSITIONS[action].to;
}

/** "kham-pha" → "KP", "canh" → "CA": prefix of package codes. */
export function packageCodePrefix(slug: string): string {
  const words = slug
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) {
    return 'PK';
  }
  if (words.length === 1) {
    return words[0].slice(0, 2);
  }
  return words
    .map((word) => word[0])
    .join('')
    .slice(0, 4);
}

/** `KP-NBN-0012` */
export function packageCode(prefix: string, partnerCode: string, sequence: number): string {
  return `${prefix}-${partnerCode}-${String(sequence).padStart(4, '0')}`;
}
