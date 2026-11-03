import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { PricingModel } from './contract.entity';

export const DOCUMENT_TEMPLATE_KINDS = ['contract', 'amendment', 'acceptance'] as const;
export type DocumentTemplateKind = (typeof DOCUMENT_TEMPLATE_KINDS)[number];

/** `upload`: a Word file of business; `default`: an interim template bundled with AG Go (Q-R9). */
export const DOCUMENT_TEMPLATE_SOURCES = ['upload', 'default'] as const;
export type DocumentTemplateSource = (typeof DOCUMENT_TEMPLATE_SOURCES)[number];

const bigintNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * One version of a DOCX template (spec 7.9, FR-D-01): a contract template per pricing model, an
 * amendment or acceptance template for every model (`pricing_model` null) or for one. Versions are
 * never edited; one version per kind / model is active and issue uses it.
 */
@Entity('document_templates')
export class DocumentTemplateEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: DocumentTemplateKind;

  /** Required for contracts; null for an amendment / acceptance template of every model. */
  @Column({ name: 'pricing_model', type: 'varchar', length: 20, nullable: true })
  pricingModel!: PricingModel | null;

  /** 1, 2, 3… per kind and pricing model. */
  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName!: string;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'size_bytes', type: 'bigint', transformer: bigintNumber })
  sizeBytes!: number;

  @Column({ name: 'checksum_sha256', type: 'varchar', length: 64 })
  checksumSha256!: string;

  /** Tags found in the file (`path` / `loop[].field`), checked against the catalog when uploaded. */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  placeholders!: string[];

  /** Recommended placeholders the file does not use (warning shown with the version). */
  @Column({ name: 'missing_recommended', type: 'jsonb', default: () => "'[]'::jsonb" })
  missingRecommended!: string[];

  @Column({ name: 'is_active', type: 'boolean', default: false })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 20, default: 'upload' })
  source!: DocumentTemplateSource;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  @Column({ name: 'activated_by', type: 'varchar', length: 128, nullable: true })
  activatedBy!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
