import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores on each evaluation row the status the media had before it (`pending` for the first one),
 * so the statistics find real status changes (decisions, backlog) with a plain filter instead of
 * looking up the previous row of every evaluation on each request.
 *
 * A BEFORE INSERT trigger fills the column from the latest earlier row of the same media, the
 * order the history is read in (`created_at`, `id`). Every writer is covered without application
 * code, including instances still running the previous release while this one rolls out. Status
 * changes only happen through evaluation rows, and a media row is locked while it is evaluated,
 * so the latest row always holds the status being replaced.
 */
export class EvaluationPreviousStatus2050000000000 implements MigrationInterface {
  name = 'EvaluationPreviousStatus2050000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE project_media_evaluations ADD COLUMN previous_status varchar(20)
    `);
    await queryRunner.query(`
      UPDATE project_media_evaluations e
      SET previous_status = h.previous_status
      FROM (
        SELECT
          id,
          COALESCE(
            LAG(evaluation_status) OVER (PARTITION BY project_media_id ORDER BY created_at, id),
            'pending'
          ) AS previous_status
        FROM project_media_evaluations
      ) h
      WHERE h.id = e.id
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION project_media_evaluations_set_previous_status()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.previous_status IS NULL THEN
          SELECT e.evaluation_status INTO NEW.previous_status
          FROM project_media_evaluations e
          WHERE e.project_media_id = NEW.project_media_id
            AND (e.created_at, e.id) < (NEW.created_at, NEW.id)
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1;
          NEW.previous_status := COALESCE(NEW.previous_status, 'pending');
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER project_media_evaluations_previous_status
      BEFORE INSERT ON project_media_evaluations
      FOR EACH ROW EXECUTE FUNCTION project_media_evaluations_set_previous_status()
    `);
    await queryRunner.query(`
      ALTER TABLE project_media_evaluations ALTER COLUMN previous_status SET NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS project_media_evaluations_previous_status ON project_media_evaluations`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS project_media_evaluations_set_previous_status()`,
    );
    await queryRunner.query(
      `ALTER TABLE project_media_evaluations DROP COLUMN IF EXISTS previous_status`,
    );
  }
}
