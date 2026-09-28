import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ICU collation that compares digit runs by numeric value ("9. ..." before "10. ..."), used when
 * ordering names such as projects so numbered items follow their natural order.
 */
export class NaturalSortCollationMigration1990000000000 implements MigrationInterface {
  name = 'NaturalSortCollationMigration1990000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE COLLATION IF NOT EXISTS natural_sort (provider = icu, locale = 'und-u-kn-true')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP COLLATION IF EXISTS natural_sort`);
  }
}
