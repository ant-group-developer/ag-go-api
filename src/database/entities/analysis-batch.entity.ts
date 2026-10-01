import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AnalysisBatchKind = 'backfill' | 'auto';
/** Stored status; `completed` is derived on read (running with nothing left to do). */
export type AnalysisBatchStatus = 'running' | 'paused' | 'cancelled';

/**
 * A scan batch: every analysis belongs to one, so a whole backfill can be paused, resumed or
 * cancelled. Uploads, re-renders and manual re-runs share the single `auto` batch.
 */
@Entity('analysis_batches')
export class AnalysisBatchEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: AnalysisBatchKind;

  /** Backfill mode (`missing` | `outdated` | `all`); null for the automatic batch. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  mode!: string | null;

  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` })
  scope!: { folderIds?: string[]; projectIds?: string[] };

  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @Column({ type: 'varchar', length: 20, default: 'running' })
  status!: AnalysisBatchStatus;

  @Column({ name: 'created_by', type: 'varchar', length: 128, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
