import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Who created each category; unknown (NULL) for those created before. */
export class CategoryCreatedBy2100000000000 implements MigrationInterface {
  name = 'CategoryCreatedBy2100000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_by varchar(128) NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE categories DROP COLUMN IF EXISTS created_by`);
  }
}
