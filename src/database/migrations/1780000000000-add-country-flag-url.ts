import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCountryFlagUrl1780000000000 implements MigrationInterface {
  name = 'AddCountryFlagUrl1780000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE countries ADD COLUMN flag_url varchar(500) NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE countries DROP COLUMN flag_url`);
  }
}
