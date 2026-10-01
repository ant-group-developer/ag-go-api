import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Whole-video analysis (scan protocol v2) and scan batches.
 *
 * - The scan no longer cuts videos into footage segments: one description per video lives on
 *   asset_analyses (description jsonb + the columns footage filters on + a search vector).
 *   media_segments and its search trigger are dropped.
 * - analysis_batches: every analysis belongs to a batch (a backfill, or the single automatic batch)
 *   so a batch can be paused, resumed and cancelled. Analyses can be `paused`.
 * - Analyses still in flight were submitted with the v1 protocol that no worker speaks any more:
 *   they are cancelled; a new backfill (extract version x2) scans them again.
 */
export class AssetAnalysisV22060000000000 implements MigrationInterface {
  name = 'AssetAnalysisV22060000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE analysis_batches (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        varchar(200) NOT NULL,
        kind        varchar(20) NOT NULL CONSTRAINT analysis_batches_kind_check CHECK (kind IN ('backfill','auto')),
        mode        varchar(20),
        scope       jsonb NOT NULL DEFAULT '{}'::jsonb,
        priority    integer NOT NULL DEFAULT 0,
        status      varchar(20) NOT NULL DEFAULT 'running'
                      CONSTRAINT analysis_batches_status_check CHECK (status IN ('running','paused','cancelled')),
        created_by  varchar(128),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // One automatic batch (uploads, re-renders, manual re-runs)
    await queryRunner.query(
      `CREATE UNIQUE INDEX analysis_batches_auto_unique ON analysis_batches(kind) WHERE kind = 'auto'`,
    );
    await queryRunner.query(
      `CREATE INDEX analysis_batches_created_idx ON analysis_batches(created_at DESC)`,
    );

    await queryRunner.query(`
      ALTER TABLE asset_analyses
        ADD COLUMN batch_id      uuid REFERENCES analysis_batches(id) ON DELETE SET NULL,
        ADD COLUMN description   jsonb,
        ADD COLUMN described_at  timestamptz,
        ADD COLUMN technical     jsonb,
        ADD COLUMN keyframes     jsonb,
        ADD COLUMN usable        boolean,
        ADD COLUMN quality       smallint,
        ADD COLUMN duration_ms   integer,
        ADD COLUMN orientation   varchar(20),
        ADD COLUMN has_audio     boolean,
        ADD COLUMN has_speech    boolean,
        ADD COLUMN search_vector tsvector
    `);
    await queryRunner.query(
      `CREATE INDEX asset_analyses_batch_status_idx ON asset_analyses(batch_id, status)`,
    );
    await queryRunner.query(
      `ALTER TABLE asset_analyses DROP CONSTRAINT asset_analyses_status_check`,
    );
    await queryRunner.query(`
      ALTER TABLE asset_analyses ADD CONSTRAINT asset_analyses_status_check
        CHECK (status IN ('queued','extracting','extracted','describing','paused','completed','failed','cancelled'))
    `);

    // Search vector from the description (A: title, keywords, topics; B: summary vi, tags, genre, places;
    // C: summary en, subjects, actions, mood; D: text on screen). immutable_unaccent: migration 2030.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION asset_analysis_json_words(doc jsonb, key text)
        RETURNS text
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
      AS $$
        SELECT coalesce(string_agg(value, ' '), '') FROM jsonb_array_elements_text(coalesce(doc -> key, '[]'::jsonb))
      $$
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION asset_analyses_search_vector_update()
        RETURNS trigger
        LANGUAGE plpgsql
      AS $$
      DECLARE d jsonb := NEW.description;
      BEGIN
        -- Nothing to search before the video is described
        IF d IS NULL THEN
          NEW.search_vector := NULL;
          RETURN NEW;
        END IF;
        NEW.search_vector :=
          setweight(to_tsvector('simple', immutable_unaccent(
            coalesce(d ->> 'title_vi', '') || ' ' ||
            asset_analysis_json_words(d, 'keywords_vi') || ' ' ||
            asset_analysis_json_words(d, 'topics')
          )), 'A') ||
          setweight(to_tsvector('simple', immutable_unaccent(
            coalesce(d ->> 'summary_vi', '') || ' ' || coalesce(d ->> 'genre', '') || ' ' ||
            asset_analysis_json_words(d, 'tags') || ' ' ||
            asset_analysis_json_words(d, 'places')
          )), 'B') ||
          setweight(to_tsvector('simple', immutable_unaccent(
            coalesce(d ->> 'summary_en', '') || ' ' || coalesce(d ->> 'mood', '') || ' ' ||
            asset_analysis_json_words(d, 'subjects') || ' ' ||
            asset_analysis_json_words(d, 'actions')
          )), 'C') ||
          setweight(to_tsvector('simple', immutable_unaccent(coalesce(d ->> 'visible_text', ''))), 'D');
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER asset_analyses_search_vector_trigger
        BEFORE INSERT OR UPDATE OF description ON asset_analyses
        FOR EACH ROW EXECUTE FUNCTION asset_analyses_search_vector_update()
    `);
    await queryRunner.query(`
      CREATE INDEX asset_analyses_search_vector_gin ON asset_analyses USING gin(search_vector) WHERE is_current = true
    `);
    await queryRunner.query(`
      CREATE INDEX asset_analyses_title_trgm ON asset_analyses
        USING gin(immutable_unaccent(lower(coalesce(description ->> 'title_vi', ''))) gin_trgm_ops)
        WHERE is_current = true
    `);

    // v1 analyses in flight cannot finish any more (their farm jobs speak the old protocol)
    await queryRunner.query(`
      UPDATE asset_analyses
         SET status = 'cancelled', reason = 'Superseded by the whole-video scan (v2)', updated_at = now()
       WHERE status IN ('queued','extracting','extracted','describing')
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS media_segments`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS media_segments_search_vector_update()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // media_segments comes back empty (segments are not recoverable from whole-video descriptions)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS media_segments (
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
        search_vector    tsvector,
        CONSTRAINT media_segments_analysis_index_unique UNIQUE (analysis_id, segment_index)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS media_segments_asset_current_idx ON media_segments(asset_id) WHERE is_current = true
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS asset_analyses_search_vector_trigger ON asset_analyses`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS asset_analyses_search_vector_update()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS asset_analysis_json_words(jsonb, text)`);
    await queryRunner.query(`DROP INDEX IF EXISTS asset_analyses_title_trgm`);
    await queryRunner.query(`DROP INDEX IF EXISTS asset_analyses_search_vector_gin`);
    await queryRunner.query(`UPDATE asset_analyses SET status = 'queued' WHERE status = 'paused'`);
    await queryRunner.query(
      `ALTER TABLE asset_analyses DROP CONSTRAINT asset_analyses_status_check`,
    );
    await queryRunner.query(`
      ALTER TABLE asset_analyses ADD CONSTRAINT asset_analyses_status_check
        CHECK (status IN ('queued','extracting','extracted','describing','completed','failed','cancelled'))
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS asset_analyses_batch_status_idx`);
    await queryRunner.query(`
      ALTER TABLE asset_analyses
        DROP COLUMN IF EXISTS batch_id,
        DROP COLUMN IF EXISTS description,
        DROP COLUMN IF EXISTS described_at,
        DROP COLUMN IF EXISTS technical,
        DROP COLUMN IF EXISTS keyframes,
        DROP COLUMN IF EXISTS usable,
        DROP COLUMN IF EXISTS quality,
        DROP COLUMN IF EXISTS duration_ms,
        DROP COLUMN IF EXISTS orientation,
        DROP COLUMN IF EXISTS has_audio,
        DROP COLUMN IF EXISTS has_speech,
        DROP COLUMN IF EXISTS search_vector
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS analysis_batches`);
  }
}
