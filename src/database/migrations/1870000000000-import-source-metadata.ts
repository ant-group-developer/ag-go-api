import { MigrationInterface, QueryRunner } from 'typeorm';

export class ImportSourceMetadataMigration1870000000000 implements MigrationInterface {
  name = 'ImportSourceMetadataMigration1870000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_imports
        ADD COLUMN IF NOT EXISTS source_width integer,
        ADD COLUMN IF NOT EXISTS source_height integer,
        ADD COLUMN IF NOT EXISTS source_duration_seconds numeric(12,3),
        ADD COLUMN IF NOT EXISTS source_creator varchar(255),
        ADD COLUMN IF NOT EXISTS source_modified_at timestamptz
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_imports
        DROP COLUMN IF EXISTS source_width,
        DROP COLUMN IF EXISTS source_height,
        DROP COLUMN IF EXISTS source_duration_seconds,
        DROP COLUMN IF EXISTS source_creator,
        DROP COLUMN IF EXISTS source_modified_at
    `);
  }
}
