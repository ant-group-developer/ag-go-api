import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { AssetAnalysisEntity } from './asset-analysis.entity';
import { AssetEntity } from './asset.entity';

@Entity('media_segments')
export class MediaSegmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'analysis_id', type: 'uuid' })
  analysisId!: string;

  @ManyToOne(() => AssetAnalysisEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'analysis_id' })
  analysis?: AssetAnalysisEntity;

  @Column({ name: 'asset_id', type: 'uuid' })
  @Index({ where: '"is_current" = true' })
  assetId!: string;

  @ManyToOne(() => AssetEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'asset_id' })
  asset?: AssetEntity;

  @Column({ name: 'segment_index', type: 'integer' })
  segmentIndex!: number;

  @Column({ name: 'start_ms', type: 'integer' })
  startMs!: number;

  @Column({ name: 'end_ms', type: 'integer' })
  endMs!: number;

  @Column({ name: 'boundary_reason', type: 'varchar', length: 40, nullable: true })
  boundaryReason!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  orientation!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  keyframes!: unknown[] | null;

  @Column({ type: 'jsonb', nullable: true })
  technical!: Record<string, unknown> | null;

  // AI description fields
  @Column({ name: 'caption_vi', type: 'text', nullable: true })
  captionVi!: string | null;

  @Column({ name: 'caption_en', type: 'text', nullable: true })
  captionEn!: string | null;

  @Column({ type: 'text', array: true, nullable: true })
  tags!: string[] | null;

  @Column({ name: 'keywords_vi', type: 'text', array: true, nullable: true })
  keywordsVi!: string[] | null;

  @Column({ type: 'text', array: true, nullable: true })
  subjects!: string[] | null;

  @Column({ type: 'text', array: true, nullable: true })
  actions!: string[] | null;

  @Column({ name: 'shot_size', type: 'varchar', length: 40, nullable: true })
  shotSize!: string | null;

  @Column({ name: 'camera_motion', type: 'varchar', length: 40, nullable: true })
  cameraMotion!: string | null;

  @Column({ name: 'time_of_day', type: 'varchar', length: 40, nullable: true })
  timeOfDay!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  setting!: string | null;

  @Column({ name: 'people_count', type: 'varchar', length: 20, nullable: true })
  peopleCount!: string | null;

  @Column({ name: 'visible_text', type: 'text', nullable: true })
  visibleText!: string | null;

  @Column({ name: 'has_watermark', type: 'boolean', nullable: true })
  hasWatermark!: boolean | null;

  @Column({ type: 'boolean', nullable: true })
  usable!: boolean | null;

  @Column({ name: 'usable_reason', type: 'text', nullable: true })
  usableReason!: string | null;

  @Column({ type: 'smallint', nullable: true })
  quality!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  description!: Record<string, unknown> | null;

  @Column({ name: 'described_at', type: 'timestamptz', nullable: true })
  describedAt!: Date | null;

  @Column({ name: 'is_current', type: 'boolean', default: false })
  isCurrent!: boolean;
}
