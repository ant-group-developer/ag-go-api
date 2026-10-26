import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Originals are granted in bundles: folders × categories, both required, checked against the
 * granter's reach when saved. `access_grants` keeps the work levels (viewer, editor, manager)
 * only, always on a folder.
 *
 * Existing `original` grants become bundles: "every folder" turns into the root folders of
 * today, "every category" into today's active categories (bundles have no "every"), and a folder
 * always covers its subfolders.
 */
export class OriginalAccessBundles2160000000000 implements MigrationInterface {
  name = 'OriginalAccessBundles2160000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE original_access_bundles (
        id uuid PRIMARY KEY,
        principal_type varchar(20) NOT NULL CHECK (principal_type = 'user'),
        principal_id varchar(128) NOT NULL,
        granted_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX original_access_bundles_principal_idx ON original_access_bundles(principal_type, principal_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX original_access_bundles_granted_by_idx ON original_access_bundles(granted_by)`,
    );
    await queryRunner.query(`
      CREATE TABLE original_access_bundle_folders (
        bundle_id uuid NOT NULL REFERENCES original_access_bundles(id) ON DELETE CASCADE,
        folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        PRIMARY KEY (bundle_id, folder_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX original_access_bundle_folders_folder_idx ON original_access_bundle_folders(folder_id)`,
    );
    await queryRunner.query(`
      CREATE TABLE original_access_bundle_categories (
        bundle_id uuid NOT NULL REFERENCES original_access_bundles(id) ON DELETE CASCADE,
        category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        PRIMARY KEY (bundle_id, category_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX original_access_bundle_categories_category_idx ON original_access_bundle_categories(category_id)`,
    );

    await queryRunner.query(`
      INSERT INTO original_access_bundles (id, principal_type, principal_id, granted_by, created_at, updated_at)
      SELECT id, principal_type, principal_id, granted_by, created_at, updated_at
      FROM access_grants
      WHERE access_level = 'original'
    `);
    await queryRunner.query(`
      INSERT INTO original_access_bundle_folders (bundle_id, folder_id)
      SELECT g.id, g.folder_id FROM access_grants g
      WHERE g.access_level = 'original' AND g.folder_id IS NOT NULL
      UNION
      SELECT g.id, f.id FROM access_grants g
      CROSS JOIN folders f
      WHERE g.access_level = 'original' AND g.folder_id IS NULL
        AND f.parent_id IS NULL AND f.is_active
    `);
    await queryRunner.query(`
      INSERT INTO original_access_bundle_categories (bundle_id, category_id)
      SELECT g.id, g.category_id FROM access_grants g
      WHERE g.access_level = 'original' AND g.category_id IS NOT NULL
      UNION
      SELECT g.id, c.id FROM access_grants g
      CROSS JOIN categories c
      WHERE g.access_level = 'original' AND g.category_id IS NULL AND c.is_active
    `);
    await queryRunner.query(`DELETE FROM access_grants WHERE access_level = 'original'`);

    await queryRunner.query(`
      ALTER TABLE access_grants
        DROP CONSTRAINT IF EXISTS access_grants_every_folder_check,
        DROP CONSTRAINT IF EXISTS access_grants_scope_check,
        DROP CONSTRAINT IF EXISTS access_grants_access_level_check,
        ADD CONSTRAINT access_grants_access_level_check
          CHECK (access_level IN ('viewer', 'editor', 'manager')),
        ALTER COLUMN folder_id SET NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE access_grants
        ALTER COLUMN folder_id DROP NOT NULL,
        DROP CONSTRAINT IF EXISTS access_grants_access_level_check,
        ADD CONSTRAINT access_grants_access_level_check
          CHECK (access_level IN ('original', 'viewer', 'editor', 'manager')),
        ADD CONSTRAINT access_grants_scope_check
          CHECK (folder_id IS NOT NULL OR category_id IS NOT NULL),
        ADD CONSTRAINT access_grants_every_folder_check
          CHECK (folder_id IS NOT NULL OR access_level = 'original')
    `);
    // Each folder × category of a bundle becomes an `original` grant (with its subfolders).
    await queryRunner.query(`
      INSERT INTO access_grants (
        id, principal_type, principal_id, folder_id, category_id, access_level, inherit_children,
        granted_by, created_at, updated_at
      )
      SELECT gen_random_uuid(), b.principal_type, b.principal_id, bf.folder_id, bc.category_id,
        'original', true, b.granted_by, b.created_at, b.updated_at
      FROM original_access_bundles b
      JOIN original_access_bundle_folders bf ON bf.bundle_id = b.id
      JOIN original_access_bundle_categories bc ON bc.bundle_id = b.id
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`DROP TABLE original_access_bundle_categories`);
    await queryRunner.query(`DROP TABLE original_access_bundle_folders`);
    await queryRunner.query(`DROP TABLE original_access_bundles`);
  }
}
