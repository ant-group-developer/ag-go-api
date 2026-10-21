import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stands for "every folder" / "every category" in the unique key, where NULLs would differ. */
const NONE = `'00000000-0000-0000-0000-000000000000'::uuid`;

/**
 * Folder and category grants become one table, so a grant can cover a category inside a folder.
 * Every user keeps what they could do: folder grants cover every category, category grants every
 * folder at the new `original` level (evaluated projects are now listed for everyone with
 * watermarked previews; the grant lets them see and download the originals).
 */
export class AccessGrants2140000000000 implements MigrationInterface {
  name = 'AccessGrants2140000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE access_grants (
        id uuid PRIMARY KEY,
        principal_type varchar(20) NOT NULL CHECK (principal_type = 'user'),
        principal_id varchar(128) NOT NULL,
        folder_id uuid NULL REFERENCES folders(id) ON DELETE CASCADE,
        category_id uuid NULL REFERENCES categories(id) ON DELETE CASCADE,
        access_level varchar(20) NOT NULL
          CHECK (access_level IN ('original', 'viewer', 'editor', 'manager')),
        inherit_children boolean NOT NULL DEFAULT true,
        granted_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT access_grants_scope_check CHECK (folder_id IS NOT NULL OR category_id IS NOT NULL),
        CONSTRAINT access_grants_every_folder_check
          CHECK (folder_id IS NOT NULL OR access_level = 'original'),
        CONSTRAINT access_grants_manager_check
          CHECK (access_level <> 'manager' OR category_id IS NULL)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX access_grants_scope_key ON access_grants (
        principal_type, principal_id, COALESCE(folder_id, ${NONE}), COALESCE(category_id, ${NONE})
      )
    `);
    await queryRunner.query(`CREATE INDEX access_grants_folder_idx ON access_grants(folder_id)`);
    await queryRunner.query(
      `CREATE INDEX access_grants_category_idx ON access_grants(category_id)`,
    );

    await queryRunner.query(`
      INSERT INTO access_grants (
        id, principal_type, principal_id, folder_id, category_id, access_level, inherit_children,
        granted_by, created_at, updated_at
      )
      SELECT id, principal_type, principal_id, folder_id, NULL, access_level, inherit_children,
        granted_by, created_at, updated_at
      FROM folder_access_grants
    `);
    await queryRunner.query(`
      INSERT INTO access_grants (
        id, principal_type, principal_id, folder_id, category_id, access_level, inherit_children,
        granted_by, created_at, updated_at
      )
      SELECT id, principal_type, principal_id, NULL, category_id, 'original', true,
        granted_by, created_at, updated_at
      FROM category_access_grants
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`DROP TABLE category_access_grants`);
    await queryRunner.query(`DROP TABLE folder_access_grants`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE folder_access_grants (
        id uuid PRIMARY KEY,
        folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        principal_type varchar(20) NOT NULL CHECK (principal_type = 'user'),
        principal_id varchar(128) NOT NULL,
        access_level varchar(20) NOT NULL CHECK (access_level IN ('viewer', 'editor', 'manager')),
        inherit_children boolean NOT NULL DEFAULT true,
        granted_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (folder_id, principal_type, principal_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX folder_access_grants_principal_idx ON folder_access_grants(principal_type, principal_id, folder_id)`,
    );
    await queryRunner.query(`
      CREATE TABLE category_access_grants (
        id uuid PRIMARY KEY,
        category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        principal_type varchar(20) NOT NULL CHECK (principal_type = 'user'),
        principal_id varchar(128) NOT NULL,
        granted_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (category_id, principal_type, principal_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX category_access_grants_principal_idx
        ON category_access_grants(principal_type, principal_id, category_id)
    `);
    // Grants limited to a category inside a folder have no old equivalent and are dropped.
    await queryRunner.query(`
      INSERT INTO folder_access_grants (
        id, folder_id, principal_type, principal_id, access_level, inherit_children, granted_by,
        created_at, updated_at
      )
      SELECT id, folder_id, principal_type, principal_id, access_level, inherit_children,
        granted_by, created_at, updated_at
      FROM access_grants
      WHERE folder_id IS NOT NULL AND category_id IS NULL AND access_level <> 'original'
    `);
    await queryRunner.query(`
      INSERT INTO category_access_grants (
        id, category_id, principal_type, principal_id, granted_by, created_at, updated_at
      )
      SELECT id, category_id, principal_type, principal_id, granted_by, created_at, updated_at
      FROM access_grants
      WHERE folder_id IS NULL
    `);
    await queryRunner.query(`DROP TABLE access_grants`);
  }
}
