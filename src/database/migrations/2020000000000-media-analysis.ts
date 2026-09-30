import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Media-analysis schema: asset_analyses, media_segments, analysis_farm_jobs.
 * Stores the results of scan.extract and scan.ai farm jobs for each asset.
 */
export class MediaAnalysisMigration2020000000000 implements MigrationInterface {
  name = 'MediaAnalysisMigration2020000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // asset_analyses: one row per analysis run; at most one is_current per asset
    await queryRunner.query(`
      CREATE TABLE asset_analyses (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        asset_id          uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        status            varchar(20) NOT NULL DEFAULT 'queued'
                            CONSTRAINT asset_analyses_status_check
                            CHECK (status IN ('queued','extracting','extracted','describing','completed','failed','cancelled')),
        reason            text,
        priority          integer NOT NULL DEFAULT 0,
        extract_version   varchar(40) NOT NULL DEFAULT 'x1',
        prompt_version    varchar(40) NOT NULL DEFAULT 'p1',
        models            jsonb,
        artifacts         jsonb,
        summary           jsonb,
        is_current        boolean NOT NULL DEFAULT false,
        requested_by      varchar(128),
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        completed_at      timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX asset_analyses_current_unique
        ON asset_analyses(asset_id)
        WHERE is_current = true
    `);
    await queryRunner.query(`
      CREATE INDEX asset_analyses_asset_id_idx ON asset_analyses(asset_id)
    `);

    // media_segments: individual segments from scan.extract + scan.ai descriptions
    await queryRunner.query(`
      CREATE TABLE media_segments (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        analysis_id      uuid NOT NULL REFERENCES asset_analyses(id) ON DELETE CASCADE,
        asset_id         uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        segment_index    integer NOT NULL,
        start_ms         integer NOT NULL,
        end_ms           integer NOT NULL,
        boundary_reason  varchar(40),
        orientation      varchar(20),
        keyframes        jsonb,
        technical        jsonb,
        -- AI description fields
        caption_vi       text,
        caption_en       text,
        tags             text[],
        keywords_vi      text[],
        subjects         text[],
        actions          text[],
        shot_size        varchar(40),
        camera_motion    varchar(40),
        time_of_day      varchar(40),
        setting          varchar(40),
        people_count     varchar(20),
        visible_text     text,
        has_watermark    boolean,
        usable           boolean,
        usable_reason    text,
        quality          smallint,
        description      jsonb,
        described_at     timestamptz,
        is_current       boolean NOT NULL DEFAULT false,
        CONSTRAINT media_segments_analysis_index_unique UNIQUE (analysis_id, segment_index)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX media_segments_asset_current_idx
        ON media_segments(asset_id)
        WHERE is_current = true
    `);

    // analysis_farm_jobs: tracks each farm job submission for a given analysis
    await queryRunner.query(`
      CREATE TABLE analysis_farm_jobs (
        farm_job_id   uuid PRIMARY KEY,
        analysis_id   uuid NOT NULL REFERENCES asset_analyses(id) ON DELETE CASCADE,
        type          varchar(40) NOT NULL,
        chunk         integer,
        status        varchar(20) NOT NULL DEFAULT 'submitted',
        error         jsonb,
        submitted_at  timestamptz NOT NULL DEFAULT now(),
        ingested_at   timestamptz,
        locked_until  timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX analysis_farm_jobs_analysis_id_idx ON analysis_farm_jobs(analysis_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS analysis_farm_jobs`);
    await queryRunner.query(`DROP TABLE IF EXISTS media_segments`);
    await queryRunner.query(`DROP TABLE IF EXISTS asset_analyses`);
  }
}
