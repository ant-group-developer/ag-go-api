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

  /** Contract of the owner (partner) the project is delivered under (FR-C-08, FR-P-09). */
  @Column({ name: 'contract_id', type: 'uuid', nullable: true })
  contractId!: string | null;

  /** When the partner delivered it: by default the first time it went to `pending` (spec 7.4). */
  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  /** Accepted on a paper acceptance record before AG Go (spec 15.3): never counted again. */
  @Column({ name: 'accepted_outside_at', type: 'timestamptz', nullable: true })
  acceptedOutsideAt!: Date | null;

  @Column({ name: 'accepted_outside_note', type: 'text', nullable: true })
  acceptedOutsideNote!: string | null;

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
