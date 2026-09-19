import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('projects')
export class ProjectEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'owner_user_id', type: 'varchar', length: 128 })
  ownerUserId!: string;

  @Column({ name: 'folder_id', type: 'uuid' })
  folderId!: string;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId!: string | null;

  @Column({ name: 'country_id', type: 'uuid', nullable: true })
  countryId!: string | null;

  @Column({ name: 'province_id', type: 'uuid', nullable: true })
  provinceId!: string | null;

  @Column({ name: 'thumbnail_project_media_id', type: 'uuid', nullable: true })
  thumbnailProjectMediaId!: string | null;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'evaluation_status', type: 'varchar', length: 30, default: 'draft' })
  evaluationStatus!: 'draft' | 'pending' | 'completed' | 'partially_completed' | 'failed';

  @Column({ name: 'media_count', type: 'integer', default: 0 })
  mediaCount!: number;

  @Column({ name: 'image_count', type: 'integer', default: 0 })
  imageCount!: number;

  @Column({ name: 'video_count', type: 'integer', default: 0 })
  videoCount!: number;

  @Column({ name: 'original_bytes', type: 'bigint', default: 0 })
  originalBytes!: string;

  @Column({ name: 'rendered_bytes', type: 'bigint', default: 0 })
  renderedBytes!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
