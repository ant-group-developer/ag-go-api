import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('system_logs')
export class SystemLogEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  level!: 'info' | 'warn' | 'error';

  @Column({ type: 'varchar', length: 40 })
  category!: string;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ name: 'request_id', type: 'varchar', length: 100, nullable: true })
  requestId!: string | null;

  @Column({ name: 'user_id', type: 'varchar', length: 128, nullable: true })
  userId!: string | null;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId!: string | null;

  @Column({ name: 'job_id', type: 'varchar', length: 255, nullable: true })
  jobId!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
