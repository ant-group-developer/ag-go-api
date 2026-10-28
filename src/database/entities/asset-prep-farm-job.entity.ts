import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type { FarmJobStatus } from './analysis-farm-job.entity';
import { AssetPrepEntity } from './asset-prep.entity';

/** A farm job of a prep (scan.prep or studio.transcribe), like `analysis_farm_jobs`. */
@Entity('asset_prep_farm_jobs')
export class AssetPrepFarmJobEntity {
  /** The UUID assigned by ag-farm when the job was created. */
  @PrimaryColumn('uuid', { name: 'farm_job_id' })
  farmJobId!: string;

  @Column({ name: 'prep_id', type: 'uuid' })
  @Index()
  prepId!: string;

  @ManyToOne(() => AssetPrepEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'prep_id' })
  prep?: AssetPrepEntity;

  @Column({ type: 'varchar', length: 40 })
  type!: string;

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

  @Column({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount!: number;
}
