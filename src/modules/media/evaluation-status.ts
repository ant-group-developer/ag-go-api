export type ProjectEvaluationStatus =
  'draft' | 'pending' | 'completed' | 'partially_completed' | 'failed';

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
