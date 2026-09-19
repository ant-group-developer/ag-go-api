import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectMediaMigration1720000000000 implements MigrationInterface {
  name = 'ProjectMediaMigration1720000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE projects
        ADD COLUMN thumbnail_project_media_id uuid NULL,
        ADD COLUMN image_count integer NOT NULL DEFAULT 0 CHECK (image_count >= 0),
        ADD COLUMN video_count integer NOT NULL DEFAULT 0 CHECK (video_count >= 0),
        ADD COLUMN original_bytes bigint NOT NULL DEFAULT 0 CHECK (original_bytes >= 0),
        ADD COLUMN rendered_bytes bigint NOT NULL DEFAULT 0 CHECK (rendered_bytes >= 0)
    `);

    await queryRunner.query(`
      CREATE TABLE assets (
        id uuid PRIMARY KEY,
        asset_type varchar(20) NOT NULL CHECK (asset_type IN ('image', 'video')),
        original_filename varchar(255) NOT NULL,
        extension varchar(20) NULL,
        mime_type varchar(100) NOT NULL,
        file_size_bytes bigint NOT NULL CHECK (file_size_bytes >= 0),
        storage_provider varchar(20) NOT NULL DEFAULT 'r2',
        original_bucket varchar(100) NOT NULL,
        original_storage_key varchar(500) NOT NULL,
        processing_status varchar(20) NOT NULL DEFAULT 'uploaded'
          CHECK (processing_status IN ('uploading', 'importing', 'uploaded', 'processing', 'ready', 'failed', 'cancelled')),
        source_type varchar(30) NOT NULL DEFAULT 'local',
        source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (storage_provider, original_bucket, original_storage_key)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX assets_processing_status_idx ON assets(processing_status, updated_at DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE project_media (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
        sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
        caption varchar(500) NULL,
        created_by varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, asset_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX project_media_project_sort_idx ON project_media(project_id, sort_order, id)`,
    );
    await queryRunner.query(
      `CREATE INDEX project_media_asset_project_idx ON project_media(asset_id, project_id)`,
    );
    await queryRunner.query(`
      ALTER TABLE projects
      ADD CONSTRAINT projects_thumbnail_project_media_fk
      FOREIGN KEY (thumbnail_project_media_id) REFERENCES project_media(id) ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE TABLE project_evaluation_summaries (
        project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        total_media integer NOT NULL DEFAULT 0 CHECK (total_media >= 0),
        pending_count integer NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
        approved_count integer NOT NULL DEFAULT 0 CHECK (approved_count >= 0),
        rejected_count integer NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
        evaluation_status varchar(30) NOT NULL DEFAULT 'draft'
          CHECK (evaluation_status IN ('draft', 'pending', 'completed', 'partially_completed', 'failed')),
        calculated_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS project_evaluation_summaries`);
    await queryRunner.query(
      `ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_thumbnail_project_media_fk`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS project_media`);
    await queryRunner.query(`DROP TABLE IF EXISTS assets`);
    await queryRunner.query(`
      ALTER TABLE projects
        DROP COLUMN IF EXISTS thumbnail_project_media_id,
        DROP COLUMN IF EXISTS image_count,
        DROP COLUMN IF EXISTS video_count,
        DROP COLUMN IF EXISTS original_bytes,
        DROP COLUMN IF EXISTS rendered_bytes
    `);
  }
}
