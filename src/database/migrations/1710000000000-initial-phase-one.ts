import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialPhaseOneMigration1710000000000 implements MigrationInterface {
  name = 'InitialPhaseOneMigration1710000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE folders (
        id uuid PRIMARY KEY,
        parent_id uuid NULL REFERENCES folders(id) ON DELETE RESTRICT,
        name varchar(200) NOT NULL,
        path_key text NOT NULL,
        path_ids uuid[] NOT NULL DEFAULT '{}',
        path_text text NOT NULL DEFAULT '',
        depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX folders_parent_sort_name_idx ON folders(parent_id, sort_order, name)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX folders_root_name_unique ON folders(lower(name)) WHERE parent_id IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX folders_child_name_unique ON folders(parent_id, lower(name)) WHERE parent_id IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE folder_closure (
        ancestor_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        descendant_id uuid NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        depth integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
        PRIMARY KEY (ancestor_id, descendant_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX folder_closure_descendant_idx ON folder_closure(descendant_id, ancestor_id)`,
    );

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
      CREATE TABLE categories (
        id uuid PRIMARY KEY,
        name varchar(200) NOT NULL,
        slug varchar(220) NOT NULL,
        description text NULL,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (slug)
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX categories_name_unique ON categories(lower(name))`,
    );
    await queryRunner.query(`
      CREATE TABLE countries (
        id uuid PRIMARY KEY,
        code varchar(10) NULL,
        name varchar(200) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX countries_name_unique ON countries(lower(name))`);
    await queryRunner.query(`
      CREATE TABLE provinces (
        id uuid PRIMARY KEY,
        country_id uuid NOT NULL REFERENCES countries(id) ON DELETE RESTRICT,
        code varchar(20) NULL,
        name varchar(200) NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX provinces_country_name_unique ON provinces(country_id, lower(name))`,
    );
    await queryRunner.query(`
      CREATE TABLE tags (
        id uuid PRIMARY KEY,
        name varchar(100) NOT NULL,
        normalized_name varchar(100) NOT NULL UNIQUE,
        created_by varchar(128) NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE projects (
        id uuid PRIMARY KEY,
        owner_user_id varchar(128) NOT NULL,
        folder_id uuid NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
        category_id uuid NULL REFERENCES categories(id) ON DELETE RESTRICT,
        country_id uuid NULL REFERENCES countries(id) ON DELETE RESTRICT,
        province_id uuid NULL REFERENCES provinces(id) ON DELETE RESTRICT,
        name varchar(200) NOT NULL,
        description text NULL,
        evaluation_status varchar(30) NOT NULL DEFAULT 'draft'
          CHECK (evaluation_status IN ('draft', 'pending', 'completed', 'partially_completed', 'failed')),
        media_count integer NOT NULL DEFAULT 0 CHECK (media_count >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX projects_folder_updated_idx ON projects(folder_id, updated_at DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX projects_owner_updated_idx ON projects(owner_user_id, updated_at DESC, id DESC)`,
    );
    await queryRunner.query(`
      CREATE TABLE project_tags (
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, tag_id)
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION validate_project_province_country()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.province_id IS NOT NULL AND NEW.country_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM provinces p
          WHERE p.id = NEW.province_id AND p.country_id = NEW.country_id
        ) THEN
          RAISE EXCEPTION 'province_id must belong to country_id';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER projects_validate_province_country
      BEFORE INSERT OR UPDATE ON projects
      FOR EACH ROW EXECUTE FUNCTION validate_project_province_country()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS projects_validate_province_country ON projects`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS validate_project_province_country`);
    await queryRunner.query(`DROP TABLE IF EXISTS project_tags`);
    await queryRunner.query(`DROP TABLE IF EXISTS projects`);
    await queryRunner.query(`DROP TABLE IF EXISTS tags`);
    await queryRunner.query(`DROP TABLE IF EXISTS provinces`);
    await queryRunner.query(`DROP TABLE IF EXISTS countries`);
    await queryRunner.query(`DROP TABLE IF EXISTS categories`);
    await queryRunner.query(`DROP TABLE IF EXISTS folder_access_grants`);
    await queryRunner.query(`DROP TABLE IF EXISTS folder_closure`);
    await queryRunner.query(`DROP TABLE IF EXISTS folders`);
  }
}
