import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectMediaEvaluationHistory1800000000000 implements MigrationInterface {
  name = 'ProjectMediaEvaluationHistory1800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE project_media_evaluations (
        id uuid PRIMARY KEY,
        project_media_id uuid NOT NULL REFERENCES project_media(id) ON DELETE CASCADE,
        evaluation_status varchar(20) NOT NULL
          CHECK (evaluation_status IN ('pending', 'approved', 'rejected')),
        comment text NULL,
        evaluated_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX project_media_evaluations_media_created_idx
      ON project_media_evaluations(project_media_id, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS project_media_evaluations`);
  }
}
