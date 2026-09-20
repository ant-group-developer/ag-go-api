import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { ProjectMediaEntity } from './project-media.entity';

@Entity('project_media_evaluations')
export class ProjectMediaEvaluationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'project_media_id', type: 'uuid' })
  projectMediaId!: string;

  @Column({ name: 'evaluation_status', type: 'varchar', length: 20 })
  evaluationStatus!: 'pending' | 'approved' | 'rejected';

  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @Column({ name: 'evaluated_by', type: 'varchar', length: 128 })
  evaluatedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => ProjectMediaEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_media_id' })
  projectMedia!: ProjectMediaEntity;
}
