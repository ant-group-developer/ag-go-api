import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('render_batches')
export class RenderBatchEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId!: string | null;

  @Column({ name: 'folder_id', type: 'uuid', nullable: true })
  folderId!: string | null;

  @Column({ name: 'render_profile_id', type: 'uuid' })
  renderProfileId!: string;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: 'queued' | 'processing' | 'paused' | 'completed' | 'partial' | 'failed' | 'cancelled';

  @Column({ name: 'total_jobs', type: 'integer', default: 0 })
  totalJobs!: number;

  @Column({ name: 'completed_jobs', type: 'integer', default: 0 })
  completedJobs!: number;

  @Column({ name: 'failed_jobs', type: 'integer', default: 0 })
  failedJobs!: number;

  @Column({ name: 'progress_percent', type: 'smallint', default: 0 })
  progressPercent!: number;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
