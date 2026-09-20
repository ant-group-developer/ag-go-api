import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('folder_access_grants')
export class FolderAccessGrantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'folder_id', type: 'uuid' })
  folderId!: string;

  @Column({ name: 'principal_type', type: 'varchar', length: 20 })
  principalType!: 'user';

  @Column({ name: 'principal_id', type: 'varchar', length: 128 })
  principalId!: string;

  @Column({ name: 'access_level', type: 'varchar', length: 20 })
  accessLevel!: 'viewer' | 'editor' | 'manager';

  @Column({ name: 'inherit_children', type: 'boolean', default: true })
  inheritChildren!: boolean;

  @Column({ name: 'granted_by', type: 'varchar', length: 128, nullable: true })
  grantedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
