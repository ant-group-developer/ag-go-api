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
import { AssetEntity } from './asset.entity';

export type AnalysisStatus =
  'queued' | 'extracting' | 'extracted' | 'describing' | 'completed' | 'failed' | 'cancelled';

export const IN_FLIGHT_STATUSES: AnalysisStatus[] = [
  'queued',
  'extracting',
  'extracted',
  'describing',
];

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
