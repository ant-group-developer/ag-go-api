import { MigrationInterface, QueryRunner } from 'typeorm';

export class GoogleDriveImportDefaultPolicyMigration1890000000000 implements MigrationInterface {
  name = 'GoogleDriveImportDefaultPolicyMigration1890000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE import_batches
        ALTER COLUMN duplicate_policy SET DEFAULT 'reuse_existing'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE import_batches
        ALTER COLUMN duplicate_policy SET DEFAULT 'create_new'
    `);
  }
}
