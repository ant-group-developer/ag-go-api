import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AnalysisBatchEntity } from './analysis-batch.entity';
import { AssetEntity } from './asset.entity';

export type AnalysisStatus =
  | 'queued'
  | 'extracting'
  | 'extracted'
  | 'describing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Not finished yet: a new analysis of the same asset is not queued while one of these exists. */
export const IN_FLIGHT_STATUSES: AnalysisStatus[] = [
  'queued',
  'extracting',
  'extracted',
  'describing',
  'paused',
];

/** Statuses whose farm work is running or about to run (not `queued`, not `paused`). */
export const RUNNING_STATUSES: AnalysisStatus[] = ['extracting', 'extracted', 'describing'];

export const FINISHED_STATUSES: AnalysisStatus[] = ['completed', 'failed', 'cancelled'];

@Entity('asset_analyses')
export class AssetAnalysisEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  @Index()
  assetId!: string;

  @ManyToOne(() => AssetEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset?: AssetEntity;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: AnalysisStatus;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ name: 'extract_version', type: 'varchar', length: 40, default: 'x1' })
  extractVersion!: string;

  @Column({ name: 'prompt_version', type: 'varchar', length: 40, default: 'p1' })
  promptVersion!: string;

  @Column({ type: 'jsonb', nullable: true })
  models!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  artifacts!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  summary!: Record<string, unknown> | null;

  @Column({ name: 'is_current', type: 'boolean', default: false })
  isCurrent!: boolean;

  @Column({ name: 'requested_by', type: 'varchar', length: 128, nullable: true })
  requestedBy!: string | null;

  /** The scan batch (a backfill or the automatic batch) this analysis runs in. */
  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId!: string | null;

  @ManyToOne(() => AnalysisBatchEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch?: AnalysisBatchEntity;

  /** Whole-video description from scan.ai (`AssetDescription`, snake_case as the worker wrote it). */
  @Column({ type: 'jsonb', nullable: true })
  description!: Record<string, unknown> | null;

  @Column({ name: 'described_at', type: 'timestamptz', nullable: true })
  describedAt!: Date | null;

  /** Whole-video technical metrics from scan.extract (`AssetTechnical`). */
  @Column({ type: 'jsonb', nullable: true })
  technical!: Record<string, unknown> | null;

  /** Representative keyframes from scan.extract (`Keyframe[]`), relative to the analysis folder. */
  @Column({ type: 'jsonb', nullable: true })
  keyframes!: Record<string, unknown>[] | null;

  /** From the description (or false when the scan found the video technically dead). */
  @Column({ type: 'boolean', nullable: true })
  usable!: boolean | null;

  @Column({ type: 'smallint', nullable: true })
  quality!: number | null;

  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs!: number | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  orientation!: string | null;

  @Column({ name: 'has_audio', type: 'boolean', nullable: true })
  hasAudio!: boolean | null;

  /** Hint from the silence ratio, not a transcript. */
  @Column({ name: 'has_speech', type: 'boolean', nullable: true })
  hasSpeech!: boolean | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
