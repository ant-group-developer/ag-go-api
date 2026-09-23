import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('download_logs')
export class DownloadLogEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ name: 'external_user_id', type: 'varchar', length: 128 })
  externalUserId!: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId!: string | null;

  @Column({ name: 'project_media_id', type: 'uuid', nullable: true })
  projectMediaId!: string | null;

  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  @Column({ name: 'download_job_id', type: 'uuid', nullable: true })
  downloadJobId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  scope!: string;

  @Column({ name: 'download_type', type: 'varchar', length: 20 })
  downloadType!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: 'started' | 'completed' | 'failed' | 'denied';

  @Column({ name: 'file_size_bytes', type: 'bigint', nullable: true })
  fileSizeBytes!: string | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
