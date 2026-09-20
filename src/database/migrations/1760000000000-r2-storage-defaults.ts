import { MigrationInterface, QueryRunner } from 'typeorm';

export class R2StorageDefaultsMigration1760000000000 implements MigrationInterface {
  name = 'R2StorageDefaultsMigration1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE assets ALTER COLUMN storage_provider SET DEFAULT 'r2'`);
    await queryRunner.query(
      `ALTER TABLE asset_upload_sessions ALTER COLUMN storage_provider SET DEFAULT 'r2'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE asset_upload_sessions ALTER COLUMN storage_provider SET DEFAULT 'local'`,
    );
    await queryRunner.query(`ALTER TABLE assets ALTER COLUMN storage_provider SET DEFAULT 'local'`);
  }
}
