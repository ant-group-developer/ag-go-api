import { Column, Entity, PrimaryColumn } from 'typeorm';

export const SPEC_CHECK_RESULTS = ['pass', 'warn', 'fail', 'unknown'] as const;
export type SpecCheckResult = (typeof SPEC_CHECK_RESULTS)[number];

/**
 * Result of checking one video of a contract-linked project against the tech spec in force on its
 * delivery day (spec 7.5, FR-T-02). Stale when the spec (`spec_hash`) or the asset's current
 * analysis (`analysis_id`) changed since `checked_at`.
 */
@Entity('media_spec_checks')
export class MediaSpecCheckEntity {
  @PrimaryColumn({ name: 'project_media_id', type: 'uuid' })
  projectMediaId!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'contract_id', type: 'uuid' })
  contractId!: string;

  /** SHA-256 of the rules applied (tech spec, model-specific terms, checker version). */
  @Column({ name: 'spec_hash', type: 'char', length: 64 })
  specHash!: string;

  /** Day whose terms were applied (the delivery day, or the check day before delivery). */
  @Column({ name: 'terms_date', type: 'date' })
  termsDate!: string;

  /** Current `asset_analyses` row used; null when the video had none yet (result `unknown`). */
  @Column({ name: 'analysis_id', type: 'uuid', nullable: true })
  analysisId!: string | null;

  @Column({ type: 'varchar', length: 10 })
  result!: SpecCheckResult;

  /** `[{ rule, level, expected, actual, message }]`, see spec-check.ts. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  findings!: Array<Record<string, unknown>>;

  @Column({ name: 'checked_at', type: 'timestamptz', default: () => 'now()' })
  checkedAt!: Date;
}
