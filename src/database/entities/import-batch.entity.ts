import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('import_batches')
export class ImportBatchEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'connection_id', type: 'uuid', nullable: true })
  connectionId!: string | null;

  @Column({ name: 'source_type', type: 'varchar', length: 20 })
  sourceType!: 'local' | 'google_drive';

  @Column({ name: 'source_drive_id', type: 'varchar', length: 255, nullable: true })
  sourceDriveId!: string | null;

  @Column({ name: 'source_root_id', type: 'varchar', length: 255, nullable: true })
  sourceRootId!: string | null;

  @Column({ name: 'duplicate_policy', type: 'varchar', length: 20, default: 'reuse_existing' })
  duplicatePolicy!: 'create_new' | 'reuse_existing' | 'overwrite_existing';

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: 'queued' | 'processing' | 'completed' | 'partial' | 'failed' | 'cancelled';

  @Column({ name: 'total_items', type: 'integer', default: 0 })
  totalItems!: number;

  @Column({ name: 'completed_items', type: 'integer', default: 0 })
  completedItems!: number;

  @Column({ name: 'failed_items', type: 'integer', default: 0 })
  failedItems!: number;

  @Column({ name: 'progress_percent', type: 'smallint', default: 0 })
  progressPercent!: number;

  @Column({ name: 'queue_job_id', type: 'varchar', length: 255, nullable: true })
  queueJobId!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255, nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
