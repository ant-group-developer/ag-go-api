import { MigrationInterface, QueryRunner } from 'typeorm';

type DuplicateCode = {
  code: string;
};

export class UniqueCountryCode1830000000000 implements MigrationInterface {
  name = 'UniqueCountryCode1830000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates = (await queryRunner.query(`
      SELECT UPPER(BTRIM(code)) AS code
      FROM countries
      WHERE code IS NOT NULL
      GROUP BY UPPER(BTRIM(code))
      HAVING COUNT(*) > 1
      LIMIT 1
    `)) as DuplicateCode[];

    if (duplicates.length > 0) {
      throw new Error(
        `Cannot add uq_countries_code because normalized country code ${duplicates[0].code} is duplicated`,
      );
    }

    await queryRunner.query(`
      ALTER TABLE countries
      ADD CONSTRAINT uq_countries_code UNIQUE (code)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE countries DROP CONSTRAINT uq_countries_code`);
  }
}
