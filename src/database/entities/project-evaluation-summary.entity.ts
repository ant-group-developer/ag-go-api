import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ProjectEntity } from './project.entity';

@Entity('project_evaluation_summaries')
export class ProjectEvaluationSummaryEntity {
  @PrimaryColumn({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @Column({ name: 'total_media', type: 'integer', default: 0 })
  totalMedia!: number;

  @Column({ name: 'pending_count', type: 'integer', default: 0 })
  pendingCount!: number;

  @Column({ name: 'approved_count', type: 'integer', default: 0 })
  approvedCount!: number;

  @Column({ name: 'rejected_count', type: 'integer', default: 0 })
  rejectedCount!: number;

  @Column({ name: 'evaluation_status', type: 'varchar', length: 30, default: 'draft' })
  evaluationStatus!: 'draft' | 'pending' | 'completed' | 'partially_completed' | 'failed';

  @UpdateDateColumn({ name: 'calculated_at', type: 'timestamptz' })
  calculatedAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToOne(() => ProjectEntity)
  @JoinColumn({ name: 'project_id' })
  project!: ProjectEntity;
}
