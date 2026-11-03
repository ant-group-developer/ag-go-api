import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Product packages of `package_tier` contracts (ANTGO-253, spec 7.4, 7.4.1, FR-K-01…08).
 *
 * A package gathers projects (scenes) of one category, one partner and one contract; each project
 * is in at most one package (`projects.package_id`). Its status follows open → submitted →
 * evaluated → accepted (or back to open when withdrawn, returned or reopened); `preview` keeps the
 * latest computation and `submitted_preview` the one at submission. `acceptance_id` is set while a
 * non-cancelled acceptance record holds the package (its foreign key comes with that table).
 */
export class ProductPackages2220000000000 implements MigrationInterface {
  name = 'ProductPackages2220000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE product_packages (
        id uuid PRIMARY KEY,
        contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
        partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
        sequence_number integer NOT NULL CHECK (sequence_number > 0),
        code varchar(40) NOT NULL,
        name varchar(200) NULL,
        status varchar(20) NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'submitted', 'evaluated', 'accepted', 'cancelled')),
        submitted_at timestamptz NULL,
        submitted_by varchar(128) NULL,
        evaluated_at timestamptz NULL,
        returned_reason text NULL,
        returned_at timestamptz NULL,
        returned_by varchar(128) NULL,
        preview jsonb NULL,
        preview_at timestamptz NULL,
        submitted_preview jsonb NULL,
        acceptance_id uuid NULL,
        acceptance_item_id uuid NULL,
        cancelled_at timestamptz NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT product_packages_code_key UNIQUE (code),
        CONSTRAINT product_packages_sequence_key UNIQUE (partner_id, sequence_number)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX product_packages_contract_status_idx ON product_packages(contract_id, status, evaluated_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX product_packages_partner_status_idx ON product_packages(partner_id, status)`,
    );
    await queryRunner.query(`
      ALTER TABLE projects
        ADD COLUMN package_id uuid NULL REFERENCES product_packages(id) ON DELETE SET NULL
    `);
    await queryRunner.query(
      `CREATE INDEX projects_package_id_idx ON projects(package_id) WHERE package_id IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS projects_package_id_idx`);
    await queryRunner.query(`ALTER TABLE projects DROP COLUMN IF EXISTS package_id`);
    await queryRunner.query(`DROP TABLE IF EXISTS product_packages`);
  }
}
