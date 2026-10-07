import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user grants on categories: they decide which evaluated projects a user sees on the
 * "Projects" page (folder grants keep deciding the "Project evaluations" page and every edit).
 */
export class CategoryAccessGrants2090000000000 implements MigrationInterface {
  name = 'CategoryAccessGrants2090000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS category_access_grants (
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
      CREATE INDEX IF NOT EXISTS category_access_grants_principal_idx
        ON category_access_grants(principal_type, principal_id, category_id)
    `);
    // The "Projects" page filters on category and status for users with category grants.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS projects_category_status_idx
        ON projects(category_id, evaluation_status)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS projects_category_status_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS category_access_grants`);
  }
}
