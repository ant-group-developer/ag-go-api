import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Render sizes move into the render profile: several preview widths (height follows the file's
 * aspect ratio) and one thumbnail width. The legacy `max_width` is kept as an extra preview width.
 */
export class RenderSizesMigration1900000000000 implements MigrationInterface {
  name = 'RenderSizesMigration1900000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE render_profiles
        ADD COLUMN IF NOT EXISTS render_sizes jsonb NOT NULL DEFAULT '{}'::jsonb
    `);
    await queryRunner.query(`
      UPDATE render_profiles
      SET render_sizes = jsonb_build_object(
        'previewWidths',
        (
          SELECT jsonb_agg(width ORDER BY width)
          FROM (
            SELECT DISTINCT width
            FROM unnest(ARRAY[480, 960, 1920] || COALESCE(ARRAY[max_width], ARRAY[]::integer[])) AS width
            WHERE width BETWEEN 64 AND 7680
          ) widths
        ),
        'thumbnailWidth', 320
      )
      WHERE render_sizes = '{}'::jsonb
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE render_profiles DROP COLUMN IF EXISTS render_sizes`);
  }
}
