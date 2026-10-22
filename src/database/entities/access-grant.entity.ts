import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Levels a grant gives, lowest first; each includes everything below it. */
export const ACCESS_LEVELS = ['viewer', 'editor', 'manager'] as const;

/**
 * Work on the projects of a folder (originals of other projects come from
 * `original_access_bundles`):
 * - `viewer`: the "Project evaluations" page, statistics, footage, change history and the
 *   originals, whatever the status.
 * - `editor`: creating, editing and deleting projects, uploads, Drive imports.
 * - `manager`: managing the folder (subfolders, moves, render batches) and its grants.
 */
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * One user's work access to the projects of a folder (with its subfolders when
 * `inheritChildren`) that belong to a category. A null category means every category,
 * uncategorized projects included (required for `manager`).
 */
@Entity('access_grants')
export class AccessGrantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'principal_type', type: 'varchar', length: 20 })
  principalType!: 'user';

  @Column({ name: 'principal_id', type: 'varchar', length: 128 })
  principalId!: string;

  @Column({ name: 'folder_id', type: 'uuid' })
  folderId!: string;

  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId!: string | null;

  @Column({ name: 'access_level', type: 'varchar', length: 20 })
  accessLevel!: AccessLevel;

  @Column({ name: 'inherit_children', type: 'boolean', default: true })
  inheritChildren!: boolean;

  @Column({ name: 'granted_by', type: 'varchar', length: 128, nullable: true })
  grantedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
