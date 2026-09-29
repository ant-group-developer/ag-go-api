import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('render_profiles')
export class RenderProfileEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'varchar', length: 50 })
  code!: string;

  @Column({ name: 'profile_version', type: 'integer', default: 1 })
  profileVersion!: number;

  @Column({ name: 'output_format', type: 'varchar', length: 20 })
  outputFormat!: string;

  @Column({ name: 'max_width', type: 'integer', nullable: true })
  maxWidth!: number | null;

  @Column({ name: 'max_height', type: 'integer', nullable: true })
  maxHeight!: number | null;

  @Column({ name: 'image_quality', type: 'smallint', default: 85 })
  imageQuality!: number;

  @Column({ name: 'video_bitrate_bps', type: 'bigint', nullable: true })
  videoBitrateBps!: string | null;

  @Column({ name: 'watermark_enabled', type: 'boolean', default: true })
  watermarkEnabled!: boolean;

  @Column({ name: 'watermark_config', type: 'jsonb', default: () => "'{}'::jsonb" })
  watermarkConfig!: Record<string, unknown>;

  /** { variants: { resolution, watermark }[]; thumbnailWidth } (legacy: previewWidths), see render/render-sizes.ts. */
  @Column({ name: 'render_sizes', type: 'jsonb', default: () => "'{}'::jsonb" })
  renderSizes!: Record<string, unknown>;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'created_by', type: 'varchar', length: 128, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
