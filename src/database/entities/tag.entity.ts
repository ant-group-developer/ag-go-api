import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('tags')
export class TagEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'normalized_name', type: 'varchar', length: 100 })
  normalizedName!: string;

  @Column({ name: 'created_by', type: 'varchar', length: 128 })
  createdBy!: string;

  /** Null for tags created before it was recorded. */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', nullable: true })
  createdAt!: Date | null;

  /** Null for tags not changed since before it was recorded. */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz', nullable: true })
  updatedAt!: Date | null;
}
