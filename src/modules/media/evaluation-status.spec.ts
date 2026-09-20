import { deriveProjectEvaluationStatus } from './evaluation-status';

describe('deriveProjectEvaluationStatus', () => {
  it.each([
    [0, 0, 0, 0, 'draft'],
    [2, 2, 0, 0, 'pending'],
    [2, 0, 2, 0, 'completed'],
    [2, 0, 0, 2, 'failed'],
    [2, 0, 1, 1, 'partially_completed'],
  ])('derives status for %s media', (total, pending, approved, rejected, expected) => {
    expect(deriveProjectEvaluationStatus(total, pending, approved, rejected)).toBe(expected);
  });
});
