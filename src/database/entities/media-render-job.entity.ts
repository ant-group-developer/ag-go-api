import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('media_render_jobs')
export class MediaRenderJobEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'render_profile_id', type: 'uuid', nullable: true })
  renderProfileId!: string | null;

  @Column({ name: 'render_batch_id', type: 'uuid', nullable: true })
  renderBatchId!: string | null;

  @Column({ name: 'render_version', type: 'integer', default: 1 })
  renderVersion!: number;

  @Column({ name: 'queue_job_id', type: 'varchar', length: 255, nullable: true })
  queueJobId!: string | null;

  @Column({ name: 'dedupe_key', type: 'varchar', length: 300 })
  dedupeKey!: string;

  @Column({ name: 'status', type: 'varchar', length: 20, default: 'queued' })
  status!: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

  @Column({ name: 'progress_percent', type: 'smallint', default: 0 })
  progressPercent!: number;

  @Column({ name: 'progress_message', type: 'varchar', length: 500, nullable: true })
  progressMessage!: string | null;

  @Column({ name: 'attempt_count', type: 'smallint', default: 0 })
  attemptCount!: number;

  @Column({ name: 'error_code', type: 'varchar', length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'created_by', type: 'varchar', length: 128, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
