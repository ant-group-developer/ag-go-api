import { MigrationInterface, QueryRunner } from 'typeorm';

export class SettingsLogs1850000000000 implements MigrationInterface {
  name = 'SettingsLogs1850000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE system_settings (
        key varchar(100) PRIMARY KEY,
        value jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO system_settings (key, value)
      VALUES
        ('web', '{"siteName":"AG Go","logoUrl":null,"faviconUrl":null,"supportEmail":null,"supportUrl":null,"primaryColor":null}'::jsonb),
        ('render', '{"profilesEnabled":true}'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE system_logs (
        id bigserial PRIMARY KEY,
        level varchar(20) NOT NULL CHECK (level IN ('info','warn','error')),
        category varchar(40) NOT NULL,
        action varchar(100) NOT NULL,
        message text NOT NULL,
        request_id varchar(100) NULL,
        user_id varchar(128) NULL,
        project_id uuid NULL,
        job_id varchar(255) NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX system_logs_created_idx ON system_logs(created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX system_logs_filter_idx ON system_logs(category, level, created_at DESC)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS system_logs');
    await queryRunner.query('DROP TABLE IF EXISTS system_settings');
  }
}
