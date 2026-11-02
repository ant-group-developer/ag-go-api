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

  /** Signed copy (→ generated_documents once contract documents exist). */
  @Column({ name: 'signed_file_id', type: 'uuid', nullable: true })
  signedFileId!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
