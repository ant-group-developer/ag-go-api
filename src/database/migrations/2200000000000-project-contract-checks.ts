import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Projects linked to contracts and automatic technical checks, phase 2 of the contracts module
 * (ANTGO-252, spec "dac-ta-hop-dong-nghiem-thu" 7.4, 7.5, 8, 15).
 *
 * `projects.contract_id` links a partner's project to one of their active contracts (FR-C-08,
 * FR-P-09); `delivered_at` is when the partner delivered it, by default the first time the project
 * went to `pending`. Projects already non-draft are backfilled with the time their first media was
 * added (that is when they left `draft`). `accepted_outside_at` marks a project accepted on a paper
 * acceptance record before AG Go (spec 15.3), so it is never counted again.
 *
 * `media_spec_checks` keeps the result of checking each video of a linked project against the
 * tech spec in force on its delivery day (one row per project media; `spec_hash` and `analysis_id`
 * tell when it is stale).
 */
export class ProjectContractChecks2200000000000 implements MigrationInterface {
  name = 'ProjectContractChecks2200000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE projects
        ADD COLUMN contract_id uuid NULL REFERENCES contracts(id) ON DELETE RESTRICT,
        ADD COLUMN delivered_at timestamptz NULL,
        ADD COLUMN accepted_outside_at timestamptz NULL,
        ADD COLUMN accepted_outside_note text NULL
    `);
    await queryRunner.query(
      `CREATE INDEX projects_contract_delivered_idx ON projects(contract_id, delivered_at)
       WHERE contract_id IS NOT NULL`,
    );
    await queryRunner.query(`
      UPDATE projects project
      SET delivered_at = COALESCE(
        (SELECT MIN(media.created_at) FROM project_media media WHERE media.project_id = project.id),
        project.updated_at
      )
      WHERE project.evaluation_status <> 'draft'
    `);

    await queryRunner.query(`
      CREATE TABLE media_spec_checks (
        project_media_id uuid PRIMARY KEY REFERENCES project_media(id) ON DELETE CASCADE,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        contract_id uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        spec_hash char(64) NOT NULL,
        terms_date date NOT NULL,
        analysis_id uuid NULL REFERENCES asset_analyses(id) ON DELETE SET NULL,
        result varchar(10) NOT NULL CHECK (result IN ('pass', 'warn', 'fail', 'unknown')),
        findings jsonb NOT NULL DEFAULT '[]'::jsonb,
        checked_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX media_spec_checks_project_id_idx ON media_spec_checks(project_id, result)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS media_spec_checks`);
    await queryRunner.query(`DROP INDEX IF EXISTS projects_contract_delivered_idx`);
    await queryRunner.query(`
      ALTER TABLE projects
        DROP COLUMN IF EXISTS accepted_outside_note,
        DROP COLUMN IF EXISTS accepted_outside_at,
        DROP COLUMN IF EXISTS delivered_at,
        DROP COLUMN IF EXISTS contract_id
    `);
  }
}
