import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('asset_imports')
export class AssetImportEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  @Column({ name: 'connection_id', type: 'uuid', nullable: true })
  connectionId!: string | null;

  @Column({ name: 'source_type', type: 'varchar', length: 20 })
  sourceType!: 'local' | 'google_drive';

  @Column({ name: 'source_drive_id', type: 'varchar', length: 255, nullable: true })
  sourceDriveId!: string | null;

  @Column({ name: 'source_file_id', type: 'varchar', length: 255, nullable: true })
  sourceFileId!: string | null;

  @Column({ name: 'source_revision_id', type: 'varchar', length: 255, nullable: true })
  sourceRevisionId!: string | null;

  @Column({ name: 'source_name', type: 'varchar', length: 255 })
  sourceName!: string;

  @Column({ name: 'source_mime_type', type: 'varchar', length: 100, nullable: true })
  sourceMimeType!: string | null;

  @Column({ name: 'source_size_bytes', type: 'bigint', nullable: true })
  sourceSizeBytes!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: 'queued' | 'importing' | 'completed' | 'failed' | 'cancelled';

  @Column({ name: 'attempt_count', type: 'smallint', default: 0 })
  attemptCount!: number;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'queue_job_id', type: 'varchar', length: 255, nullable: true })
  queueJobId!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
