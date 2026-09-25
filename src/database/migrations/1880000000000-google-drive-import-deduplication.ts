import { MigrationInterface, QueryRunner } from 'typeorm';

export class GoogleDriveImportDeduplicationMigration1880000000000 implements MigrationInterface {
  name = 'GoogleDriveImportDeduplicationMigration1880000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assets
        ADD COLUMN IF NOT EXISTS google_drive_file_id varchar(255)
    `);
    await queryRunner.query(`
      UPDATE assets
      SET google_drive_file_id = NULLIF(source_metadata->>'sourceFileId', '')
      WHERE google_drive_file_id IS NULL
        AND source_type = 'google_drive'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS assets_google_drive_file_id_idx
      ON assets(google_drive_file_id)
      WHERE google_drive_file_id IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE import_batches
        ADD COLUMN IF NOT EXISTS duplicate_policy varchar(20) NOT NULL DEFAULT 'reuse_existing'
    `);
    await queryRunner.query(`
      ALTER TABLE import_batches
        DROP CONSTRAINT IF EXISTS import_batches_duplicate_policy_check
    `);
    await queryRunner.query(`
      ALTER TABLE import_batches
        ADD CONSTRAINT import_batches_duplicate_policy_check
        CHECK (duplicate_policy IN ('create_new', 'reuse_existing', 'overwrite_existing'))
    `);
    await queryRunner.query(`
      ALTER TABLE asset_imports
        ADD COLUMN IF NOT EXISTS resolution varchar(20) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE asset_imports
        DROP CONSTRAINT IF EXISTS asset_imports_resolution_check
    `);
    await queryRunner.query(`
      ALTER TABLE asset_imports
        ADD CONSTRAINT asset_imports_resolution_check
        CHECK (resolution IS NULL OR resolution IN ('created', 'reused', 'overwritten'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE asset_imports DROP CONSTRAINT IF EXISTS asset_imports_resolution_check',
    );
    await queryRunner.query('ALTER TABLE asset_imports DROP COLUMN IF EXISTS resolution');
    await queryRunner.query(
      'ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_duplicate_policy_check',
    );
    await queryRunner.query('ALTER TABLE import_batches DROP COLUMN IF EXISTS duplicate_policy');
    await queryRunner.query('DROP INDEX IF EXISTS assets_google_drive_file_id_idx');
    await queryRunner.query('ALTER TABLE assets DROP COLUMN IF EXISTS google_drive_file_id');
  }
}
