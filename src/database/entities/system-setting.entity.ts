import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('system_settings')
export class SystemSettingEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  value!: Record<string, unknown>;

  @Column({ name: 'updated_by', type: 'varchar', length: 128, nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
