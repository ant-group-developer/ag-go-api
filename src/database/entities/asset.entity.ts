import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('assets')
export class AssetEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'asset_type', type: 'varchar', length: 20 })
  assetType!: 'image' | 'video';

  @Column({ name: 'original_filename', type: 'varchar', length: 255 })
  originalFilename!: string;

  @Column({ name: 'extension', type: 'varchar', length: 20, nullable: true })
  extension!: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ name: 'checksum_sha256', type: 'char', length: 64, nullable: true })
  checksumSha256!: string | null;

  @Column({ name: 'file_size_bytes', type: 'bigint' })
  fileSizeBytes!: string;

  @Column({ name: 'storage_provider', type: 'varchar', length: 20, default: 'r2' })
  storageProvider!: string;

  @Column({ name: 'original_bucket', type: 'varchar', length: 100 })
  originalBucket!: string;

  @Column({ name: 'original_storage_key', type: 'varchar', length: 500 })
  originalStorageKey!: string;

  @Column({ name: 'processing_status', type: 'varchar', length: 20, default: 'uploaded' })
  processingStatus!: string;

  @Column({ name: 'source_type', type: 'varchar', length: 30, default: 'local' })
  sourceType!: string;

  @Column({ name: 'source_metadata', type: 'jsonb', default: () => "'{}'::jsonb" })
  sourceMetadata!: Record<string, unknown>;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
