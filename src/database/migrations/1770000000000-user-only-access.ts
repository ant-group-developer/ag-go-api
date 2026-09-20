import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserOnlyAccessMigration1770000000000 implements MigrationInterface {
  name = 'UserOnlyAccessMigration1770000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM folder_access_grants
      WHERE principal_type <> 'user'
    `);
    await queryRunner.query(`
      ALTER TABLE folder_access_grants
        DROP CONSTRAINT IF EXISTS folder_access_grants_principal_type_check
    `);
    await queryRunner.query(`
      ALTER TABLE folder_access_grants
        ADD CONSTRAINT folder_access_grants_principal_type_check
        CHECK (principal_type = 'user')
    `);

    const userColumns = [
      ['folders', 'created_by'],
      ['folder_access_grants', 'principal_id'],
      ['folder_access_grants', 'granted_by'],
      ['projects', 'owner_user_id'],
      ['assets', 'created_by'],
      ['project_media', 'created_by'],
      ['asset_upload_sessions', 'created_by'],
      ['media_render_jobs', 'created_by'],
      ['tags', 'created_by'],
    ];

    for (const [table, column] of userColumns) {
      const where =
        table === 'folder_access_grants'
          ? `principal_type = 'user' AND ${column} LIKE 'auth0|%'`
          : `${column} LIKE 'auth0|%'`;
      await queryRunner.query(`
        UPDATE ${table}
        SET ${column} = substring(${column} FROM 7)
        WHERE ${where}
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE folder_access_grants
        DROP CONSTRAINT IF EXISTS folder_access_grants_principal_type_check
    `);
    await queryRunner.query(`
      ALTER TABLE folder_access_grants
        ADD CONSTRAINT folder_access_grants_principal_type_check
        CHECK (principal_type = 'user')
    `);
  }
}
