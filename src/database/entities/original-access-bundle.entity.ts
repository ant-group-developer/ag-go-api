import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One grant of originals: the user sees un-watermarked previews and downloads the originals of
 * the evaluated projects that are in one of the bundle's folders (subfolders included) and in
 * one of its categories. Checked against the granter's own reach when saved only: it stays as
 * it is whatever happens to the granter later.
 */
@Entity('original_access_bundles')
export class OriginalAccessBundleEntity {
  @PrimaryColumn('uuid')
  id!: string;

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

/** A folder of a bundle; its subfolders are covered too. */
@Entity('original_access_bundle_folders')
export class OriginalAccessBundleFolderEntity {
  @PrimaryColumn({ name: 'bundle_id', type: 'uuid' })
  bundleId!: string;

  @PrimaryColumn({ name: 'folder_id', type: 'uuid' })
  folderId!: string;
}

@Entity('original_access_bundle_categories')
export class OriginalAccessBundleCategoryEntity {
  @PrimaryColumn({ name: 'bundle_id', type: 'uuid' })
  bundleId!: string;

  @PrimaryColumn({ name: 'category_id', type: 'uuid' })
  categoryId!: string;
}
