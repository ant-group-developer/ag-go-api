import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectMediaEvaluation1790000000000 implements MigrationInterface {
  name = 'ProjectMediaEvaluation1790000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE project_media
        ADD COLUMN evaluation_status varchar(20) NOT NULL DEFAULT 'pending'
          CHECK (evaluation_status IN ('pending', 'approved', 'rejected'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE project_media
        DROP COLUMN IF EXISTS evaluation_status
    `);
  }
}
