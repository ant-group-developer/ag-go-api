import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { PricingModel } from './contract.entity';

export const ACCEPTANCE_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'issued',
  'signed',
  'partially_paid',
  'paid',
  'cancelled',
] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export const DELIVERY_METHODS = ['ag_go', 'hard_drive', 'google_drive', 'other'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

export const ACCEPTANCE_UNITS = [
  'topic',
  'shot',
  'clip',
  'package',
  'extra_scene',
  'source',
] as const;
export type AcceptanceUnit = (typeof ACCEPTANCE_UNITS)[number];

const bigintNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

const numericNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

export type AcceptanceWarning = { code: string; message: string; packageId?: string };

/** Acceptance record (BBNT, "Phụ lục hợp đồng số N") of one contract and period (spec 7.6). */
@Entity('acceptance_records')
export class AcceptanceRecordEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'contract_id', type: 'uuid' })
  contractId!: string;

  @Column({ name: 'partner_id', type: 'uuid' })
  partnerId!: string;

  /** Pricing model of the contract when the record was made. */
  @Column({ name: 'pricing_model', type: 'varchar', length: 20 })
  pricingModel!: PricingModel;

  /** Given when issued (BR-07): `contracts.last_appendix_number + 1`, never reused. */
  @Column({ name: 'appendix_number', type: 'integer', nullable: true })
  appendixNumber!: number | null;

  @Column({ name: 'period_start', type: 'date' })
  periodStart!: string;

  /** Prices and terms are those in force on this day (Q-R1). */
  @Column({ name: 'period_end', type: 'date' })
  periodEnd!: string;

  @Column({ name: 'record_date', type: 'date', nullable: true })
  recordDate!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: AcceptanceStatus;

  @Column({ name: 'delivery_method', type: 'varchar', length: 20, default: 'ag_go' })
  deliveryMethod!: DeliveryMethod;

  @Column({ name: 'delivery_note', type: 'text', nullable: true })
  deliveryNote!: string | null;

  @Column({ name: 'gross_amount', type: 'bigint', default: 0, transformer: bigintNumber })
  grossAmount!: number;

  @Column({
    name: 'tax_rate',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 10,
    transformer: numericNumber,
  })
  taxRate!: number;

  @Column({ name: 'tax_amount', type: 'bigint', default: 0, transformer: bigintNumber })
  taxAmount!: number;

  /** The tax was typed by the preparer (AG Music ReportAmountCalculator). */
  @Column({ name: 'tax_overridden', type: 'boolean', default: false })
  taxOverridden!: boolean;

  @Column({ name: 'tax_override_reason', type: 'text', nullable: true })
  taxOverrideReason!: string | null;

  @Column({ name: 'advance_offset_amount', type: 'bigint', default: 0, transformer: bigintNumber })
  advanceOffsetAmount!: number;

  @Column({ name: 'advance_offset_overridden', type: 'boolean', default: false })
  advanceOffsetOverridden!: boolean;

  @Column({ name: 'advance_offset_reason', type: 'text', nullable: true })
  advanceOffsetReason!: string | null;

  /** gross − tax − advance offset. */
  @Column({ name: 'net_payable', type: 'bigint', default: 0, transformer: bigintNumber })
  netPayable!: number;

  @Column({ name: 'net_payable_words', type: 'text', nullable: true })
  netPayableWords!: string | null;

  /** Rate card version that priced the record (package_tier / per_source). */
  @Column({ name: 'rate_card_id', type: 'uuid', nullable: true })
  rateCardId!: string | null;

  /** Pricing terms and tech spec in force on the last day of the period. */
  @Column({ name: 'terms_snapshot', type: 'jsonb', nullable: true })
  termsSnapshot!: Record<string, unknown> | null;

  /** AG Account profile captured when issued (BR-02), AES-256-GCM; never returned. */
  @Column({ name: 'partner_snapshot_enc', type: 'text', nullable: true, select: false })
  partnerSnapshotEnc!: string | null;

  @Column({ name: 'partner_snapshot_at', type: 'timestamptz', nullable: true })
  partnerSnapshotAt!: Date | null;

  /** Party A details when issued (documents, later). */
  @Column({ name: 'company_snapshot', type: 'jsonb', nullable: true })
  companySnapshot!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  warnings!: AcceptanceWarning[];

  /** Projects / packages the preparer took off the draft (FR-A-04); kept across recalculations. */
  @Column({ name: 'excluded_project_ids', type: 'uuid', array: true, default: () => "'{}'" })
  excludedProjectIds!: string[];

  @Column({ name: 'excluded_package_ids', type: 'uuid', array: true, default: () => "'{}'" })
  excludedPackageIds!: string[];

  @Column({ name: 'calculated_at', type: 'timestamptz', nullable: true })
  calculatedAt!: Date | null;

  /** Decision of the approver on the warnings (80/20, tier drop…), Q-R3. */
  @Column({ name: 'approval_note', type: 'text', nullable: true })
  approvalNote!: string | null;

  @Column({ name: 'return_reason', type: 'text', nullable: true })
  returnReason!: string | null;

  @Column({ name: 'returned_at', type: 'timestamptz', nullable: true })
  returnedAt!: Date | null;

  @Column({ name: 'returned_by', type: 'varchar', length: 128, nullable: true })
  returnedBy!: string | null;

  @Column({ name: 'prepared_by', type: 'varchar', length: 128 })
  preparedBy!: string;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ name: 'submitted_by', type: 'varchar', length: 128, nullable: true })
  submittedBy!: string | null;

  @Column({ name: 'approved_at', type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  @Column({ name: 'approved_by', type: 'varchar', length: 128, nullable: true })
  approvedBy!: string | null;

  @Column({ name: 'issued_at', type: 'timestamptz', nullable: true })
  issuedAt!: Date | null;

  @Column({ name: 'issued_by', type: 'varchar', length: 128, nullable: true })
  issuedBy!: string | null;

  @Column({ name: 'signed_at', type: 'timestamptz', nullable: true })
  signedAt!: Date | null;

  /** Signed copy (→ generated_documents once acceptance documents exist). */
  @Column({ name: 'signed_file_id', type: 'uuid', nullable: true })
  signedFileId!: string | null;

  /** Payment due date (BR-34), set when signed. */
  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate!: string | null;

  /** Template the document is generated from (documents, later). */
  @Column({ name: 'template_version_id', type: 'uuid', nullable: true })
  templateVersionId!: string | null;

  @Column({ name: 'cancelled_reason', type: 'text', nullable: true })
  cancelledReason!: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @Column({ name: 'cancelled_by', type: 'varchar', length: 128, nullable: true })
  cancelledBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/** One line of the record (spec 7.7): computed values next to the final (adjusted) ones. */
@Entity('acceptance_items')
export class AcceptanceItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'acceptance_id', type: 'uuid' })
  acceptanceId!: string;

  @Column({ name: 'line_no', type: 'integer' })
  lineNo!: number;

  /** Stable key of the line (`package:<id>`, `topic:<category>`…) to keep adjustments on recalculation. */
  @Column({ name: 'line_key', type: 'varchar', length: 120 })
  lineKey!: string;

  @Column({ name: 'product_label', type: 'varchar', length: 200 })
  productLabel!: string;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId!: string | null;

  @Column({ name: 'package_id', type: 'uuid', nullable: true })
  packageId!: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  level!: string | null;

  /** Price cell used (traces the rate card version). */
  @Column({ name: 'rate_card_item_id', type: 'uuid', nullable: true })
  rateCardItemId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  unit!: AcceptanceUnit;

  @Column({
    name: 'computed_quantity',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericNumber,
  })
  computedQuantity!: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numericNumber })
  quantity!: number;

  @Column({ name: 'computed_unit_price', type: 'bigint', transformer: bigintNumber })
  computedUnitPrice!: number;

  @Column({ name: 'unit_price', type: 'bigint', transformer: bigintNumber })
  unitPrice!: number;

  @Column({ name: 'computed_amount', type: 'bigint', transformer: bigintNumber })
  computedAmount!: number;

  @Column({ type: 'bigint', transformer: bigintNumber })
  amount!: number;

  /** e.g. `{ "sources": 158, "scenes": 14, "tier": 3, "durationRatio": 0.82 }`. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metrics!: Record<string, unknown>;

  /** Required when quantity or unit price differ from the computed ones (BR-14). */
  @Column({ name: 'adjustment_reason', type: 'text', nullable: true })
  adjustmentReason!: string | null;

  @Column({ name: 'adjusted_by', type: 'varchar', length: 128, nullable: true })
  adjustedBy!: string | null;

  @Column({ name: 'adjusted_at', type: 'timestamptz', nullable: true })
  adjustedAt!: Date | null;
}

/** Project (and later media) behind a line, counted or not, with the reason (spec 7.7). */
@Entity('acceptance_item_sources')
export class AcceptanceItemSourceEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'acceptance_id', type: 'uuid' })
  acceptanceId!: string;

  @Column({ name: 'acceptance_item_id', type: 'uuid', nullable: true })
  acceptanceItemId!: string | null;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  /** Null: the whole project. */
  @Column({ name: 'project_media_id', type: 'uuid', nullable: true })
  projectMediaId!: string | null;

  @Column({ name: 'package_id', type: 'uuid', nullable: true })
  packageId!: string | null;

  @Column({ type: 'boolean' })
  counted!: boolean;

  @Column({ name: 'exclusion_reason', type: 'varchar', length: 100, nullable: true })
  exclusionReason!: string | null;

  @Column({ name: 'exclusion_message', type: 'text', nullable: true })
  exclusionMessage!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0, transformer: numericNumber })
  quantity!: number;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metrics!: Record<string, unknown>;

  /** Counted on a record not cancelled: the project cannot be counted elsewhere. */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;
}
