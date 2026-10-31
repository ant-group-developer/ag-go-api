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

export type UploadMetrics = {
  client: Record<string, string | number | undefined> | null;
  /** Measured on complete; absent for a failed upload. */
  server?: {
    /** Time to assemble multipart parts on R2; absent for single PUT uploads. */
    assembleMs?: number;
    /** Time the complete call took in the API. */
    completeMs: number;
    /** From opening the session to the end of complete: what the user waited in total. */
    sinceSessionMs: number;
  };
  /** Why the upload failed, as reported by the browser when it gave up on the upload. */
  failure?: UploadFailureRecord;
};

/** See `UploadFailureDto`. */
export type UploadFailureRecord = {
  stage: string;
  message: string;
  httpStatus?: number;
  partNumber?: number;
  bytesSent?: number;
  partsDone?: number;
  elapsedMs?: number;
  errors?: Array<{ atMs: number; partNumber?: number; httpStatus?: number; message: string }>;
};

@Entity('asset_upload_sessions')
export class AssetUploadSessionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'target_project_id', type: 'uuid', nullable: true })
  targetProjectId!: string | null;

  @Column({ name: 'storage_provider', type: 'varchar', length: 20, default: 'r2' })
  storageProvider!: string;

  @Column({ name: 'bucket_name', type: 'varchar', length: 100 })
  bucketName!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 500 })
  storageKey!: string;

  @Column({ name: 'multipart_upload_id', type: 'text', nullable: true })
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

  /** Upload timings: `client` as sent by the browser, `server` measured on complete. */
  @Column({ name: 'upload_metrics', type: 'jsonb', nullable: true })
  uploadMetrics!: UploadMetrics | null;

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
