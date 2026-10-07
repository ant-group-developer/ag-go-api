import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Lets a user see the evaluated projects of a category on the "Projects" page, read-only.
 * Unlike folder grants there is no level: editing still needs an editor grant on the folder.
 */
@Entity('category_access_grants')
export class CategoryAccessGrantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId!: string;

  @Column({ name: 'principal_type', type: 'varchar', length: 20 })
  principalType!: 'user';

  @Column({ name: 'principal_id', type: 'varchar', length: 128 })
  principalId!: string;

  @Column({ name: 'granted_by', type: 'varchar', length: 128, nullable: true })
  grantedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
