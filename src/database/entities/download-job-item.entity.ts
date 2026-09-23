import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('download_job_items')
export class DownloadJobItemEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'download_job_id', type: 'uuid' })
  downloadJobId!: string;

  @Column({ name: 'project_media_id', type: 'uuid' })
  projectMediaId!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: 'queued' | 'added' | 'failed';

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
