import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Render profiles list preview variants instead of widths: a short-edge resolution ("720p") and
 * whether it carries the watermark, so one file can have e.g. a watermarked 720p and a clean
 * 1080p. Existing widths become the usual 16:9 short edge with the profile's watermark switch.
 *
 * `asset_variants.render_spec` records how a variant was rendered (size, watermark look,
 * quality), so a later render can keep variants that still match instead of rendering them again.
 * `media_render_jobs.reuse_existing` says whether a job may do that, and `render_summary` lists
 * which variants a finished job rendered, reused and removed.
 */
export class RenderVariantsMigration2010000000000 implements MigrationInterface {
  name = 'RenderVariantsMigration2010000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_variants ADD COLUMN IF NOT EXISTS render_spec varchar(300)
    `);
    await queryRunner.query(`
      ALTER TABLE media_render_jobs
        ADD COLUMN IF NOT EXISTS reuse_existing boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS render_summary jsonb
    `);
    await queryRunner.query(`
      UPDATE render_profiles profile
      SET render_sizes = profile.render_sizes || jsonb_build_object(
        'variants',
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object('resolution', resolution, 'watermark', profile.watermark_enabled)
              ORDER BY resolution
            )
            FROM (
              SELECT DISTINCT LEAST(4320, GREATEST(144,
                CASE width
                  WHEN 3840 THEN 2160
                  WHEN 2560 THEN 1440
                  WHEN 1920 THEN 1080
                  WHEN 1280 THEN 720
                  WHEN 960 THEN 540
                  WHEN 854 THEN 480
                  WHEN 640 THEN 360
                  ELSE ROUND(width * 9 / 16.0)::integer
                END
              )) AS resolution
              FROM jsonb_array_elements_text(
                COALESCE(profile.render_sizes -> 'previewWidths', '[]'::jsonb)
              ) AS widths(value)
              CROSS JOIN LATERAL (SELECT value::integer AS width) parsed
              WHERE value ~ '^[0-9]+$'
            ) resolutions
          ),
          '[]'::jsonb
        )
      )
      WHERE NOT (profile.render_sizes ? 'variants')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE render_profiles SET render_sizes = render_sizes - 'variants'`);
    await queryRunner.query(`
      ALTER TABLE media_render_jobs
        DROP COLUMN IF EXISTS render_summary,
        DROP COLUMN IF EXISTS reuse_existing
    `);
    await queryRunner.query(`ALTER TABLE asset_variants DROP COLUMN IF EXISTS render_spec`);
  }
}
