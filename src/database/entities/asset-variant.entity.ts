import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('asset_variants')
export class AssetVariantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'render_profile_id', type: 'uuid', nullable: true })
  renderProfileId!: string | null;

  @Column({ name: 'variant_code', type: 'varchar', length: 50 })
  variantCode!: string;

  @Column({ name: 'render_version', type: 'integer', default: 1 })
  renderVersion!: number;

  @Column({ name: 'storage_provider', type: 'varchar', length: 20, default: 'local' })
  storageProvider!: string;

  @Column({ name: 'bucket_name', type: 'varchar', length: 100 })
  bucketName!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 500 })
  storageKey!: string;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ name: 'file_size_bytes', type: 'bigint', default: 0 })
  fileSizeBytes!: string;

  @Column({ name: 'width', type: 'integer', nullable: true })
  width!: number | null;

  @Column({ name: 'height', type: 'integer', nullable: true })
  height!: number | null;

  @Column({ name: 'has_watermark', type: 'boolean', default: false })
  hasWatermark!: boolean;

  /**
   * How the variant was rendered (size, watermark look, quality); a render with the same spec
   * keeps it instead of rendering it again. Null for variants rendered before specs existed.
   */
  @Column({ name: 'render_spec', type: 'varchar', length: 300, nullable: true })
  renderSpec!: string | null;

  @Column({ name: 'status', type: 'varchar', length: 20, default: 'processing' })
  status!: 'processing' | 'ready' | 'failed';

  @Column({ name: 'processing_error', type: 'text', nullable: true })
  processingError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
