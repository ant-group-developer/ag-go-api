import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const CONTRACT_STATUSES = [
  'draft',
  'issued',
  'active',
  'suspended',
  'completed',
  'terminated',
] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const CONTRACT_TYPES = ['content_production'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const PRICING_MODELS = ['per_topic', 'per_unit', 'package_tier'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const ACCEPTANCE_CYCLES = ['on_demand', 'weekly', 'monthly'] as const;
export type AcceptanceCycle = (typeof ACCEPTANCE_CYCLES)[number];

export const ADVANCE_OFFSET_RULES = ['full_first', 'proportional'] as const;
export type AdvanceOffsetRule = (typeof ADVANCE_OFFSET_RULES)[number];

/** `system`: made in AG Go; `legacy_import`: signed outside and imported (FR-C-11). */
export const CONTRACT_SOURCES = ['system', 'legacy_import'] as const;
export type ContractSource = (typeof CONTRACT_SOURCES)[number];

/** Money is whole đồng in `bigint` columns; read back as numbers (far below 2^53). */
const bigintNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

const numericNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/** A content-production contract between ANT Group and one partner (spec 7.2). */
@Entity('contracts')
export class ContractEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId!: string;

  /** `DDMMYY/HĐSXND/AG-<partner code>` (BR-05), unique; imported contracts keep their number. */
  @Column({ name: 'contract_number', type: 'varchar', length: 60 })
  contractNumber!: string;

  @Column({ name: 'contract_type', type: 'varchar', length: 30, default: 'content_production' })
  contractType!: ContractType;

  /** Required to activate. */
  @Column({ name: 'signed_date', type: 'date', nullable: true })
  signedDate!: string | null;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  /** Null: until the obligations are fulfilled. */
  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: ContractStatus;

  @Column({ name: 'pricing_model', type: 'varchar', length: 20 })
  pricingModel!: PricingModel;

  /** Validated against the schema of `pricing_model` (pricing-config.ts). */
  @Column({ name: 'pricing_config', type: 'jsonb' })
  pricingConfig!: Record<string, unknown>;

  /** Ceiling of the contract value; null = no ceiling. */
  @Column({ name: 'cap_amount', type: 'bigint', nullable: true, transformer: bigintNumber })
  capAmount!: number | null;

  @Column({ name: 'advance_amount', type: 'bigint', default: 0, transformer: bigintNumber })
  advanceAmount!: number;

  /** Required when there is an advance. */
  @Column({ name: 'advance_due_business_days', type: 'integer', nullable: true })
  advanceDueBusinessDays!: number | null;

  @Column({ name: 'advance_offset_rule', type: 'varchar', length: 20, default: 'full_first' })
  advanceOffsetRule!: AdvanceOffsetRule;

  @Column({ name: 'acceptance_cycle', type: 'varchar', length: 10 })
  acceptanceCycle!: AcceptanceCycle;

  /** e.g. `{ "type": "monthly_before_day", "day": 15 }` or `{ "type": "flexible" }`. */
  @Column({ name: 'delivery_rule', type: 'jsonb', nullable: true })
  deliveryRule!: Record<string, unknown> | null;

  @Column({ name: 'payment_term_business_days', type: 'integer' })
  paymentTermBusinessDays!: number;

  /** Technical requirements checked on delivered media (spec 8.1). */
  @Column({ name: 'tech_spec', type: 'jsonb' })
  techSpec!: Record<string, unknown>;

  @Column({
    name: 'penalty_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 8,
    transformer: numericNumber,
  })
  penaltyPercent!: number;

  @Column({ name: 'originality_min_percent', type: 'integer', nullable: true })
  originalityMinPercent!: number | null;

  @Column({ name: 'similarity_max_percent', type: 'integer', nullable: true, default: 30 })
  similarityMaxPercent!: number | null;

  @Column({ name: 'non_compete_months', type: 'integer', nullable: true, default: 24 })
  nonCompeteMonths!: number | null;

  /** Template the contract file is issued from (document templates come later). */
  @Column({ name: 'template_version_id', type: 'uuid', nullable: true })
  templateVersionId!: string | null;

  @Column({ name: 'manager_user_id', type: 'varchar', length: 128 })
  managerUserId!: string;

  /**
   * AG Account profile captured when the contract is issued (BR-02): JSON encrypted with
   * AES-256-GCM (PiiCipherService). Never returned by the API.
   */
  @Column({ name: 'partner_snapshot_enc', type: 'text', nullable: true, select: false })
  partnerSnapshotEnc!: string | null;

  @Column({ name: 'partner_snapshot_at', type: 'timestamptz', nullable: true })
  partnerSnapshotAt!: Date | null;

  /**
   * Last acceptance appendix number used (BR-07): the next one is this + 1. Imported contracts
   * start from the number already used outside AG Go.
   */
  @Column({ name: 'last_appendix_number', type: 'integer', default: 0 })
  lastAppendixNumber!: number;

  @Column({ type: 'varchar', length: 20, default: 'system' })
  source!: ContractSource;

  /** Totals of an imported contract before AG Go (FR-C-11): accepted, paid, advance left. */
  @Column({
    name: 'legacy_accepted_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintNumber,
  })
  legacyAcceptedAmount!: number | null;

  @Column({ name: 'legacy_paid_amount', type: 'bigint', nullable: true, transformer: bigintNumber })
  legacyPaidAmount!: number | null;

  @Column({
    name: 'legacy_advance_balance',
    type: 'bigint',
    nullable: true,
    transformer: bigintNumber,
  })
  legacyAdvanceBalance!: number | null;

  /** Signed copy (→ generated_documents once contract documents exist). */
  @Column({ name: 'signed_file_id', type: 'uuid', nullable: true })
  signedFileId!: string | null;

  /** Why an administrator activated without a signed copy. */
  @Column({ name: 'activation_note', type: 'text', nullable: true })
  activationNote!: string | null;

  /** Reason of the last suspension. */
  @Column({ name: 'suspended_reason', type: 'text', nullable: true })
  suspendedReason!: string | null;

  @Column({ name: 'terminated_reason', type: 'text', nullable: true })
  terminatedReason!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'issued_at', type: 'timestamptz', nullable: true })
  issuedAt!: Date | null;

  @Column({ name: 'issued_by', type: 'varchar', length: 128, nullable: true })
  issuedBy!: string | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  @Column({ name: 'activated_by', type: 'varchar', length: 128, nullable: true })
  activatedBy!: string | null;

  /** When it became completed or terminated. */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
