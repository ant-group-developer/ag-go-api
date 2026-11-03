import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const CONTRACT_AMENDMENT_STATUSES = ['draft', 'issued', 'signed'] as const;
export type ContractAmendmentStatus = (typeof CONTRACT_AMENDMENT_STATUSES)[number];

/**
 * An amendment of an active contract's terms (spec 7.3). The terms in force on day D are the
 * contract's, with every `signed` amendment of `effective_date <= D` applied in number order.
 */
@Entity('contract_amendments')
export class ContractAmendmentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'contract_id', type: 'uuid' })
  contractId!: string;

  /** 1, 2, 3… within the contract. */
  @Column({ name: 'amendment_number', type: 'integer' })
  amendmentNumber!: number;

  @Column({ name: 'effective_date', type: 'date' })
  effectiveDate!: string;

  /** New values of the amended terms (`pricing_config`, `cap_amount`, `tech_spec`…). */
  @Column({ type: 'jsonb' })
  changes!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  status!: ContractAmendmentStatus;

  /** Signed copy uploaded (generated_documents, kind `signed`). */
  @Column({ name: 'signed_file_id', type: 'uuid', nullable: true })
  signedFileId!: string | null;

  /** AG Account profile captured when issued (BR-02), AES-256-GCM; never returned. */
  @Column({ name: 'partner_snapshot_enc', type: 'text', nullable: true, select: false })
  partnerSnapshotEnc!: string | null;

  @Column({ name: 'partner_snapshot_at', type: 'timestamptz', nullable: true })
  partnerSnapshotAt!: Date | null;

  /** Party A details captured when issued (FR-D-05). */
  @Column({ name: 'company_snapshot', type: 'jsonb', nullable: true })
  companySnapshot!: Record<string, unknown> | null;

  /** Template version the amendment file was issued from (FR-D-01). */
  @Column({ name: 'template_version_id', type: 'uuid', nullable: true })
  templateVersionId!: string | null;

  @Column({ name: 'issued_at', type: 'timestamptz', nullable: true })
  issuedAt!: Date | null;

  @Column({ name: 'issued_by', type: 'varchar', length: 128, nullable: true })
  issuedBy!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
