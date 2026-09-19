import { MigrationInterface, QueryRunner } from 'typeorm';

export class LocalUploadRenderMigration1740000000000 implements MigrationInterface {
  name = 'LocalUploadRenderMigration1740000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE assets
        ADD COLUMN checksum_sha256 char(64) NULL
    `);

    await queryRunner.query(`
      CREATE TABLE asset_upload_sessions (
        id uuid PRIMARY KEY,
        asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        storage_provider varchar(20) NOT NULL DEFAULT 'local',
        bucket_name varchar(100) NOT NULL,
        storage_key varchar(500) NOT NULL,
        multipart_upload_id varchar(255) NULL,
        expected_size_bytes bigint NULL CHECK (expected_size_bytes >= 0),
        expected_checksum_sha256 char(64) NULL,
        idempotency_key varchar(255) NULL,
        status varchar(20) NOT NULL DEFAULT 'initiated'
          CHECK (status IN ('initiated', 'uploading', 'completed', 'expired', 'aborted')),
        expires_at timestamptz NOT NULL,
        completed_at timestamptz NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (storage_provider, bucket_name, storage_key)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX asset_upload_sessions_idempotency_idx
      ON asset_upload_sessions(created_by, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    await queryRunner.query(
      `CREATE INDEX asset_upload_sessions_expiry_idx ON asset_upload_sessions(status, expires_at)`,
    );

    await queryRunner.query(`
      CREATE TABLE asset_variants (
        id uuid PRIMARY KEY,
        asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        render_profile_id uuid NULL,
        variant_code varchar(50) NOT NULL,
        render_version integer NOT NULL DEFAULT 1,
        storage_provider varchar(20) NOT NULL DEFAULT 'local',
        bucket_name varchar(100) NOT NULL,
        storage_key varchar(500) NOT NULL,
        mime_type varchar(100) NOT NULL,
        file_size_bytes bigint NOT NULL DEFAULT 0 CHECK (file_size_bytes >= 0),
        width integer NULL,
        height integer NULL,
        has_watermark boolean NOT NULL DEFAULT false,
        status varchar(20) NOT NULL DEFAULT 'processing'
          CHECK (status IN ('processing', 'ready', 'failed')),
        processing_error text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (asset_id, variant_code)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX asset_variants_asset_status_idx ON asset_variants(asset_id, status)`,
    );

    await queryRunner.query(`
      CREATE TABLE media_render_jobs (
        id uuid PRIMARY KEY,
        asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        render_profile_id uuid NULL,
        render_version integer NOT NULL DEFAULT 1,
        queue_job_id varchar(255) NULL,
        dedupe_key varchar(300) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
        progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
        progress_message varchar(500) NULL,
        attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        error_code varchar(100) NULL,
        error_message text NULL,
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        created_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX media_render_jobs_active_dedupe_idx ON media_render_jobs(dedupe_key) WHERE status IN ('queued', 'processing')`,
    );
    await queryRunner.query(
      `CREATE INDEX media_render_jobs_status_created_idx ON media_render_jobs(status, created_at)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS media_render_jobs`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_variants`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_upload_sessions`);
    await queryRunner.query(`ALTER TABLE assets DROP COLUMN IF EXISTS checksum_sha256`);
  }
}
