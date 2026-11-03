import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const PACKAGE_STATUSES = [
  'open',
  'submitted',
  'evaluated',
  'accepted',
  'cancelled',
] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/**
 * Product package (spec 7.4.1): the unit paid by a `package_tier` contract, a set of projects
 * (scenes) of one category, one partner and one contract, gathered by the partner or their
 * manager. Its tier comes from the sources and scenes it holds, not from a week or month.
 */
@Entity('product_packages')
export class ProductPackageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'contract_id', type: 'uuid' })
  contractId!: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId!: string;

  /** Product of the package; one of the contract's `category_ids`. */
  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  /** Running number per partner, part of the code. */
  @Column({ name: 'sequence_number', type: 'integer' })
  sequenceNumber!: number;

  /** e.g. `KP-NBN-0012`. */
  @Column({ type: 'varchar', length: 40 })
  code!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: PackageStatus;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ name: 'submitted_by', type: 'varchar', length: 128, nullable: true })
  submittedBy!: string | null;

  /** When every project of the package was evaluated (FR-K-06). */
  @Column({ name: 'evaluated_at', type: 'timestamptz', nullable: true })
  evaluatedAt!: Date | null;

  @Column({ name: 'returned_reason', type: 'text', nullable: true })
  returnedReason!: string | null;

  @Column({ name: 'returned_at', type: 'timestamptz', nullable: true })
  returnedAt!: Date | null;

  @Column({ name: 'returned_by', type: 'varchar', length: 128, nullable: true })
  returnedBy!: string | null;

  /** Latest computation: `{ sources, scenes, tier, extraScenes, amount, durationRatio, warnings… }`. */
  @Column({ type: 'jsonb', nullable: true })
  preview!: Record<string, unknown> | null;

  @Column({ name: 'preview_at', type: 'timestamptz', nullable: true })
  previewAt!: Date | null;

  /** Computation when submitted, to warn when the evaluation lowers the tier (FR-K-08). */
  @Column({ name: 'submitted_preview', type: 'jsonb', nullable: true })
  submittedPreview!: Record<string, unknown> | null;

  /** Acceptance record (not cancelled) holding the package, from its draft on. */
  @Column({ name: 'acceptance_id', type: 'uuid', nullable: true })
  acceptanceId!: string | null;

  /** Line of that record pricing the package. */
  @Column({ name: 'acceptance_item_id', type: 'uuid', nullable: true })
  acceptanceItemId!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
