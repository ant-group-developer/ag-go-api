import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssetEntity } from './asset.entity';

@Entity('project_media')
export class ProjectMediaEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @Column({ name: 'caption', type: 'varchar', length: 500, nullable: true })
  caption!: string | null;

  @Column({ name: 'evaluation_status', type: 'varchar', length: 20, default: 'pending' })
  evaluationStatus!: 'pending' | 'approved' | 'rejected';

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => AssetEntity, { eager: false })
  @JoinColumn({ name: 'asset_id' })
  asset!: AssetEntity;
}
