export const PROJECT_EVALUATION_STATUSES = [
  'draft',
  'pending',
  'completed',
  'partially_completed',
  'failed',
] as const;
export type ProjectEvaluationStatus = (typeof PROJECT_EVALUATION_STATUSES)[number];

export function deriveProjectEvaluationStatus(
  total: number,
  pending: number,
  approved: number,
  rejected: number,
): ProjectEvaluationStatus {
  if (total === 0) {
    return 'draft';
  }
  if (pending > 0) {
    return 'pending';
  }
  if (approved === total) {
    return 'completed';
  }
  if (rejected === total) {
    return 'failed';
  }
  return 'partially_completed';
}
