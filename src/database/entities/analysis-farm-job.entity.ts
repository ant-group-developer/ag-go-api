import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AssetAnalysisEntity } from './asset-analysis.entity';

export type FarmJobStatus = 'submitted' | 'ingested' | 'failed';

@Entity('analysis_farm_jobs')
export class AnalysisFarmJobEntity {
  /** The UUID assigned by ag-farm when the job was created. */
  @PrimaryColumn('uuid', { name: 'farm_job_id' })
  farmJobId!: string;

  @Column({ name: 'analysis_id', type: 'uuid' })
  @Index()
  analysisId!: string;

  @ManyToOne(() => AssetAnalysisEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'analysis_id' })
  analysis?: AssetAnalysisEntity;

  @Column({ type: 'varchar', length: 40 })
  type!: string;

  @Column({ type: 'integer', nullable: true })
  chunk!: number | null;

  @Column({ type: 'varchar', length: 20, default: 'submitted' })
  status!: FarmJobStatus;

  @Column({ type: 'jsonb', nullable: true })
  error!: Record<string, unknown> | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', default: () => 'now()' })
  submittedAt!: Date;

  @Column({ name: 'ingested_at', type: 'timestamptz', nullable: true })
  ingestedAt!: Date | null;

  /** Set while an outbox worker ingests the result, so other outbox hosts skip it. */
  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;
}
