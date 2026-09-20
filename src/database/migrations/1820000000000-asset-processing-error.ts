import { MigrationInterface, QueryRunner } from 'typeorm';

export class AssetProcessingError1820000000000 implements MigrationInterface {
  name = 'AssetProcessingError1820000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assets
        ADD COLUMN processing_error text NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assets
        DROP COLUMN IF EXISTS processing_error
    `);
  }
}
