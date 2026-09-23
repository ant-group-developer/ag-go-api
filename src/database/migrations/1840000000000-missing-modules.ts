import { MigrationInterface, QueryRunner } from 'typeorm';

export class MissingModules1840000000000 implements MigrationInterface {
  name = 'MissingModules1840000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE render_profiles (
        id uuid PRIMARY KEY,
        name varchar(100) NOT NULL,
        code varchar(50) NOT NULL,
        profile_version integer NOT NULL DEFAULT 1 CHECK (profile_version > 0),
        output_format varchar(20) NOT NULL,
        max_width integer NULL,
        max_height integer NULL,
        image_quality smallint NOT NULL DEFAULT 85 CHECK (image_quality BETWEEN 1 AND 100),
        video_bitrate_bps bigint NULL,
        watermark_enabled boolean NOT NULL DEFAULT true,
        watermark_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_active boolean NOT NULL DEFAULT true,
        created_by varchar(128) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (code, profile_version)
      )
    `);
    await queryRunner.query(`
      INSERT INTO render_profiles
        (id, name, code, profile_version, output_format, max_width, max_height,
         image_quality, watermark_enabled, watermark_config, is_active)
      VALUES
        ('00000000-0000-7000-8000-000000000001', 'Default Watermarked Preview',
         'default', 1, 'webp', 1920, 1080, 85, true,
         '{"position":"bottom-right","opacity":0.65}'::jsonb, true)
      ON CONFLICT (code, profile_version) DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE render_batches (
        id uuid PRIMARY KEY,
        project_id uuid NULL,
        folder_id uuid NULL,
        render_profile_id uuid NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','processing','completed','partial','failed','cancelled')),
        total_jobs integer NOT NULL DEFAULT 0,
        completed_jobs integer NOT NULL DEFAULT 0,
        failed_jobs integer NOT NULL DEFAULT 0,
        progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
        error_message text NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      ALTER TABLE media_render_jobs
      ADD COLUMN IF NOT EXISTS render_batch_id uuid NULL
    `);

    await queryRunner.query(`
      CREATE TABLE google_drive_connections (
        id uuid PRIMARY KEY,
        external_user_id varchar(128) NOT NULL,
        google_subject varchar(255) NOT NULL,
        encrypted_refresh_token text NOT NULL,
        scopes text[] NOT NULL DEFAULT '{}',
        expires_at timestamptz NULL,
        status varchar(20) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','revoked','error')),
        last_error text NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (external_user_id, google_subject)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE import_batches (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        connection_id uuid NULL REFERENCES google_drive_connections(id) ON DELETE SET NULL,
        source_type varchar(20) NOT NULL CHECK (source_type IN ('local','google_drive')),
        source_drive_id varchar(255) NULL,
        source_root_id varchar(255) NULL,
        status varchar(20) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','processing','completed','partial','failed','cancelled')),
        total_items integer NOT NULL DEFAULT 0,
        completed_items integer NOT NULL DEFAULT 0,
        failed_items integer NOT NULL DEFAULT 0,
        progress_percent smallint NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
        queue_job_id varchar(255) NULL,
        idempotency_key varchar(255) NULL,
        error_message text NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX import_batches_idempotency_idx
      ON import_batches(created_by, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE asset_imports (
        id uuid PRIMARY KEY,
        batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        asset_id uuid NULL REFERENCES assets(id) ON DELETE SET NULL,
        connection_id uuid NULL REFERENCES google_drive_connections(id) ON DELETE SET NULL,
        source_type varchar(20) NOT NULL CHECK (source_type IN ('local','google_drive')),
        source_drive_id varchar(255) NULL,
        source_file_id varchar(255) NULL,
        source_revision_id varchar(255) NULL,
        source_name varchar(255) NOT NULL,
        source_mime_type varchar(100) NULL,
        source_size_bytes bigint NULL,
        status varchar(20) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','importing','completed','failed','cancelled')),
        attempt_count smallint NOT NULL DEFAULT 0,
        error_code varchar(100) NULL,
        error_message text NULL,
        queue_job_id varchar(255) NULL,
        started_at timestamptz NULL,
        finished_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX asset_imports_batch_status_idx
      ON asset_imports(batch_id, status, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE download_jobs (
        id uuid PRIMARY KEY,
        external_user_id varchar(128) NOT NULL,
        project_id uuid NULL,
        scope varchar(20) NOT NULL CHECK (scope IN ('single','multiple','project')),
        download_type varchar(20) NOT NULL DEFAULT 'original'
          CHECK (download_type IN ('original','rendered')),
        status varchar(20) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','processing','completed','failed','expired','cancelled')),
        total_items integer NOT NULL DEFAULT 0,
        completed_items integer NOT NULL DEFAULT 0,
        zip_bucket varchar(100) NULL,
        zip_storage_key varchar(500) NULL,
        zip_size_bytes bigint NULL,
        expires_at timestamptz NULL,
        error_message text NULL,
        queue_job_id varchar(255) NULL,
        idempotency_key varchar(255) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX download_jobs_idempotency_idx
      ON download_jobs(external_user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE download_job_items (
        id uuid PRIMARY KEY,
        download_job_id uuid NOT NULL REFERENCES download_jobs(id) ON DELETE CASCADE,
        project_media_id uuid NOT NULL REFERENCES project_media(id) ON DELETE CASCADE,
        asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        status varchar(20) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','added','failed')),
        error_message text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (download_job_id, project_media_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE download_logs (
        id bigserial PRIMARY KEY,
        external_user_id varchar(128) NOT NULL,
        project_id uuid NULL,
        project_media_id uuid NULL,
        asset_id uuid NULL,
        download_job_id uuid NULL,
        scope varchar(20) NOT NULL,
        download_type varchar(20) NOT NULL,
        status varchar(20) NOT NULL CHECK (status IN ('started','completed','failed','denied')),
        file_size_bytes bigint NULL,
        ip_address inet NULL,
        user_agent text NULL,
        error_code varchar(100) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX download_logs_user_idx
      ON download_logs(external_user_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE TABLE project_audit_logs (
        id bigserial PRIMARY KEY,
        project_id uuid NULL,
        project_media_id uuid NULL,
        actor_user_id varchar(128) NOT NULL,
        action varchar(50) NOT NULL,
        before_data jsonb NULL,
        after_data jsonb NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX project_audit_logs_project_idx
      ON project_audit_logs(project_id, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS project_audit_logs');
    await queryRunner.query('DROP TABLE IF EXISTS download_logs');
    await queryRunner.query('DROP TABLE IF EXISTS download_job_items');
    await queryRunner.query('DROP INDEX IF EXISTS download_jobs_idempotency_idx');
    await queryRunner.query('DROP TABLE IF EXISTS download_jobs');
    await queryRunner.query('DROP TABLE IF EXISTS asset_imports');
    await queryRunner.query('DROP INDEX IF EXISTS import_batches_idempotency_idx');
    await queryRunner.query('DROP TABLE IF EXISTS import_batches');
    await queryRunner.query('DROP TABLE IF EXISTS google_drive_connections');
    await queryRunner.query('ALTER TABLE media_render_jobs DROP COLUMN IF EXISTS render_batch_id');
    await queryRunner.query('DROP TABLE IF EXISTS render_batches');
    await queryRunner.query('DROP TABLE IF EXISTS render_profiles');
  }
}
