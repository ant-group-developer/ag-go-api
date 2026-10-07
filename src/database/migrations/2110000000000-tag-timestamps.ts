import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When each tag was created and last updated. Existing tags stay NULL (unknown) instead of
 * taking the migration time; the defaults only apply to tags created from now on.
 */
export class TagTimestamps2110000000000 implements MigrationInterface {
  name = 'TagTimestamps2110000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tags
        ADD COLUMN IF NOT EXISTS created_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NULL
    `);
    await queryRunner.query(`
      ALTER TABLE tags
        ALTER COLUMN created_at SET DEFAULT now(),
        ALTER COLUMN updated_at SET DEFAULT now()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tags
        DROP COLUMN IF EXISTS updated_at,
        DROP COLUMN IF EXISTS created_at
    `);
  }
}
