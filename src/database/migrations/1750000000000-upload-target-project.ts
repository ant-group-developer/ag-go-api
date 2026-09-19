import { MigrationInterface, QueryRunner } from 'typeorm';

export class UploadTargetProjectMigration1750000000000 implements MigrationInterface {
  name = 'UploadTargetProjectMigration1750000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE asset_upload_sessions
        ADD COLUMN target_project_id uuid NULL REFERENCES projects(id) ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE asset_upload_sessions DROP COLUMN IF EXISTS target_project_id`,
    );
  }
}
