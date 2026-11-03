import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export const DOCUMENT_OWNER_TYPES = ['contract', 'amendment', 'acceptance'] as const;
export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

/** `generated`: rendered by AG Go from a template; `signed`: the signed copy uploaded (FR-D-04). */
export const GENERATED_DOCUMENT_KINDS = ['generated', 'signed'] as const;
export type GeneratedDocumentKind = (typeof GENERATED_DOCUMENT_KINDS)[number];

export const GENERATED_DOCUMENT_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export type GeneratedDocumentStatus = (typeof GENERATED_DOCUMENT_STATUSES)[number];

/** `skipped`: no Gotenberg configured (Q4: DOCX only). */
export const PDF_STATUSES = ['none', 'pending', 'ready', 'failed', 'skipped'] as const;
export type PdfStatus = (typeof PDF_STATUSES)[number];

const bigintNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * A document of a contract, an amendment or an acceptance record (spec 7.9): a version rendered by
 * the worker (DOCX, PDF through Gotenberg when configured) or a signed copy uploaded. Stored in R2
 * under `contract-documents/` (spec 12.5) and read back only through the API.
 */
@Entity('generated_documents')
export class GeneratedDocumentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'contract_id', type: 'uuid' })
  contractId!: string;

  @Column({ name: 'owner_type', type: 'varchar', length: 20 })
  ownerType!: DocumentOwnerType;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: GeneratedDocumentKind;

  /** 1, 2, 3… per owner and kind (a re-issued contract gets a new version). */
  @Column({ type: 'integer' })
  version!: number;

  /** Template version used (FR-D-01); null for a signed copy. */
  @Column({ name: 'template_id', type: 'uuid', nullable: true })
  templateId!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: GeneratedDocumentStatus;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName!: string;

  @Column({ name: 'content_type', type: 'varchar', length: 120 })
  contentType!: string;

  @Column({ name: 'storage_key', type: 'text', nullable: true })
  storageKey!: string | null;

  @Column({ name: 'size_bytes', type: 'bigint', nullable: true, transformer: bigintNumber })
  sizeBytes!: number | null;

  @Column({ name: 'checksum_sha256', type: 'varchar', length: 64, nullable: true })
  checksumSha256!: string | null;

  @Column({ name: 'pdf_status', type: 'varchar', length: 20, default: 'none' })
  pdfStatus!: PdfStatus;

  @Column({ name: 'pdf_storage_key', type: 'text', nullable: true })
  pdfStorageKey!: string | null;

  @Column({ name: 'pdf_size_bytes', type: 'bigint', nullable: true, transformer: bigintNumber })
  pdfSizeBytes!: number | null;

  @Column({ name: 'pdf_checksum_sha256', type: 'varchar', length: 64, nullable: true })
  pdfChecksumSha256!: string | null;

  /** Last error of the DOCX render (no personal data). */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'pdf_error', type: 'text', nullable: true })
  pdfError!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'generated_at', type: 'timestamptz', nullable: true })
  generatedAt!: Date | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
