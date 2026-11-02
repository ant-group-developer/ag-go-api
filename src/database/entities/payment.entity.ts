import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * `advance`: advance paid to the partner (FR-$-01); `settlement`: payment of an issued acceptance
 * record (FR-$-02), also the release of a tax held (BR-30); `refund`: the partner returns advance
 * not offset, e.g. when the contract is terminated (FR-C-10, BR-35).
 */
export const PAYMENT_KINDS = ['advance', 'settlement', 'refund'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Payments are never deleted: a wrong one is cancelled with a reason. */
export const PAYMENT_STATUSES = ['recorded', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const bigintNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/** Money paid to or returned by a partner under a contract (spec 7.8), in whole đồng. */
@Entity('payments')
export class PaymentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'contract_id', type: 'uuid' })
  contractId!: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId!: string;

  /** The acceptance record paid; null for advances and refunds. */
  @Column({ name: 'acceptance_id', type: 'uuid', nullable: true })
  acceptanceId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  kind!: PaymentKind;

  @Column({ type: 'bigint', transformer: bigintNumber })
  amount!: number;

  @Column({ name: 'paid_date', type: 'date' })
  paidDate!: string;

  @Column({ type: 'varchar', length: 20, default: 'bank_transfer' })
  method!: PaymentMethod;

  /** Bank transaction reference. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'recorded' })
  status!: PaymentStatus;

  /** Transfer proof (PDF / image) in R2 under `contract-documents/`, read back through the API. */
  @Column({ name: 'proof_storage_key', type: 'text', nullable: true, select: false })
  proofStorageKey!: string | null;

  @Column({ name: 'proof_file_name', type: 'varchar', length: 255, nullable: true })
  proofFileName!: string | null;

  @Column({ name: 'proof_content_type', type: 'varchar', length: 120, nullable: true })
  proofContentType!: string | null;

  @Column({
    name: 'proof_size_bytes',
    type: 'bigint',
    nullable: true,
    transformer: bigintNumber,
  })
  proofSizeBytes!: number | null;

  @Column({ name: 'proof_checksum_sha256', type: 'varchar', length: 64, nullable: true })
  proofChecksumSha256!: string | null;

  @Column({ name: 'proof_uploaded_at', type: 'timestamptz', nullable: true })
  proofUploadedAt!: Date | null;

  @Column({ name: 'proof_uploaded_by', type: 'varchar', length: 128, nullable: true })
  proofUploadedBy!: string | null;

  @Column({ name: 'cancelled_reason', type: 'text', nullable: true })
  cancelledReason!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancelled_by', type: 'varchar', length: 128, nullable: true })
  cancelledBy!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
