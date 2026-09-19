import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssetEntity } from './asset.entity';

@Entity('asset_upload_sessions')
export class AssetUploadSessionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'target_project_id', type: 'uuid', nullable: true })
  targetProjectId!: string | null;

  @Column({ name: 'storage_provider', type: 'varchar', length: 20, default: 'local' })
  storageProvider!: string;

  @Column({ name: 'bucket_name', type: 'varchar', length: 100 })
  bucketName!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 500 })
  storageKey!: string;

  @Column({ name: 'multipart_upload_id', type: 'varchar', length: 255, nullable: true })
  multipartUploadId!: string | null;

  @Column({ name: 'expected_size_bytes', type: 'bigint', nullable: true })
  expectedSizeBytes!: string | null;

  @Column({ name: 'expected_checksum_sha256', type: 'char', length: 64, nullable: true })
  expectedChecksumSha256!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'status', type: 'varchar', length: 20, default: 'initiated' })
  status!: 'initiated' | 'uploading' | 'completed' | 'expired' | 'aborted';

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => AssetEntity, { eager: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset!: AssetEntity;
}
