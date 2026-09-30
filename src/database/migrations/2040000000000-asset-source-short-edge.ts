import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Short edge (pixels) of an asset's source file, kept by Postgres from the width/height the media
 * workers write into `source_metadata`. The statistics group media by resolution with it: reading
 * the jsonb of every asset on each request was the slowest part of that query.
 *
 * A stored generated column is always in sync with the metadata and needs no application code.
 * It stays null until both sizes are numbers, and numeric (not integer) so no metadata value can
 * make a write fail. Adding it rewrites `assets` once.
 */
export class AssetSourceShortEdge2040000000000 implements MigrationInterface {
  name = 'AssetSourceShortEdge2040000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assets
        ADD COLUMN source_short_edge numeric GENERATED ALWAYS AS (
          CASE
            WHEN jsonb_typeof(source_metadata->'width') = 'number'
              AND jsonb_typeof(source_metadata->'height') = 'number'
              AND (source_metadata->>'width')::numeric > 0
              AND (source_metadata->>'height')::numeric > 0
            THEN LEAST((source_metadata->>'width')::numeric, (source_metadata->>'height')::numeric)
          END
        ) STORED
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE assets DROP COLUMN IF EXISTS source_short_edge`);
  }
}
