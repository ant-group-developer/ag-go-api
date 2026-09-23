import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('download_jobs')
export class DownloadJobEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 128 })
  externalUserId!: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  scope!: 'single' | 'multiple' | 'project';

  @Column({ name: 'download_type', type: 'varchar', length: 20, default: 'original' })
  downloadType!: 'original' | 'rendered';

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: 'queued' | 'processing' | 'completed' | 'failed' | 'expired' | 'cancelled';

  @Column({ name: 'total_items', type: 'integer', default: 0 })
  totalItems!: number;

  @Column({ name: 'completed_items', type: 'integer', default: 0 })
  completedItems!: number;

  @Column({ name: 'zip_bucket', type: 'varchar', length: 100, nullable: true })
  zipBucket!: string | null;

  @Column({ name: 'zip_storage_key', type: 'varchar', length: 500, nullable: true })
  zipStorageKey!: string | null;

  @Column({ name: 'zip_size_bytes', type: 'bigint', nullable: true })
  zipSizeBytes!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'queue_job_id', type: 'varchar', length: 255, nullable: true })
  queueJobId!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, nullable: true })
  idempotencyKey!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
