import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds full-text search support for footage segments.
 *
 * Steps:
 *   1. Enable unaccent and pg_trgm extensions.
 *   2. Create an IMMUTABLE wrapper immutable_unaccent(text) using the C-language function.
 *   3. Add search_vector tsvector column to media_segments.
 *   4. Create a trigger to keep search_vector up to date.
 *   5. Backfill existing rows.
 *   6. Create GIN index on search_vector and trigram GIN index on unaccented caption_vi.
 *
 * Extension privilege note: from PG 13, unaccent and pg_trgm are trusted extensions — a role
 * with CREATE privilege on the database can CREATE EXTENSION IF NOT EXISTS directly. If the
 * role does NOT have that privilege, the migration fails with a clear message telling an
 * operator to run `CREATE EXTENSION unaccent; CREATE EXTENSION pg_trgm;` as a superuser.
 */
export class FootageSearch2020000000000 implements MigrationInterface {
  name = 'FootageSearch2020000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // -----------------------------------------------------------------------
    // 1. Extensions
    // -----------------------------------------------------------------------
    try {
      await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    } catch (err) {
      throw new Error(
        `Migration ${this.name} failed: could not create extension "unaccent". ` +
          `Run: CREATE EXTENSION unaccent; as a superuser, then retry. Original: ${String(err)}`,
      );
    }

    try {
      await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    } catch (err) {
      throw new Error(
        `Migration ${this.name} failed: could not create extension "pg_trgm". ` +
          `Run: CREATE EXTENSION pg_trgm; as a superuser, then retry. Original: ${String(err)}`,
      );
    }

    // -----------------------------------------------------------------------
    // 2. IMMUTABLE unaccent wrapper
    //    Postgres' built-in unaccent() is STABLE, not IMMUTABLE, so it cannot
    //    be used directly in GIN/tsvector expressions. The C-language call
    //    through unaccent(regdictionary, text) IS safe to mark IMMUTABLE.
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION immutable_unaccent(text)
        RETURNS text
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        STRICT
      AS $$
        SELECT public.unaccent('public.unaccent', $1)
      $$
    `);

    // -----------------------------------------------------------------------
    // 3. search_vector column
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE media_segments
        ADD COLUMN IF NOT EXISTS search_vector tsvector
    `);

    // -----------------------------------------------------------------------
    // 4. Trigger function (weights: A caption_vi/keywords_vi, B caption_en/tags,
    //                               C subjects/actions, D visible_text)
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION media_segments_search_vector_update()
        RETURNS trigger
        LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.search_vector :=
          setweight(to_tsvector('simple',
            immutable_unaccent(coalesce(NEW.caption_vi, '')) || ' ' ||
            immutable_unaccent(array_to_string(coalesce(NEW.keywords_vi, '{}'), ' '))
          ), 'A') ||
          setweight(to_tsvector('simple',
            immutable_unaccent(coalesce(NEW.caption_en, '')) || ' ' ||
            immutable_unaccent(array_to_string(coalesce(NEW.tags, '{}'), ' '))
          ), 'B') ||
          setweight(to_tsvector('simple',
            immutable_unaccent(array_to_string(coalesce(NEW.subjects, '{}'), ' ')) || ' ' ||
            immutable_unaccent(array_to_string(coalesce(NEW.actions, '{}'), ' '))
          ), 'C') ||
          setweight(to_tsvector('simple',
            immutable_unaccent(coalesce(NEW.visible_text, ''))
          ), 'D');
        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS media_segments_search_vector_trigger ON media_segments
    `);

    await queryRunner.query(`
      CREATE TRIGGER media_segments_search_vector_trigger
        BEFORE INSERT OR UPDATE OF caption_vi, caption_en, tags, keywords_vi,
                                   subjects, actions, visible_text
        ON media_segments
        FOR EACH ROW EXECUTE FUNCTION media_segments_search_vector_update()
    `);

    // -----------------------------------------------------------------------
    // 5. Backfill existing rows
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      UPDATE media_segments SET search_vector =
        setweight(to_tsvector('simple',
          immutable_unaccent(coalesce(caption_vi, '')) || ' ' ||
          immutable_unaccent(array_to_string(coalesce(keywords_vi, '{}'), ' '))
        ), 'A') ||
        setweight(to_tsvector('simple',
          immutable_unaccent(coalesce(caption_en, '')) || ' ' ||
          immutable_unaccent(array_to_string(coalesce(tags, '{}'), ' '))
        ), 'B') ||
        setweight(to_tsvector('simple',
          immutable_unaccent(array_to_string(coalesce(subjects, '{}'), ' ')) || ' ' ||
          immutable_unaccent(array_to_string(coalesce(actions, '{}'), ' '))
        ), 'C') ||
        setweight(to_tsvector('simple',
          immutable_unaccent(coalesce(visible_text, ''))
        ), 'D')
    `);

    // -----------------------------------------------------------------------
    // 6. Indexes
    // -----------------------------------------------------------------------
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS media_segments_search_vector_gin
        ON media_segments USING gin(search_vector)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS media_segments_caption_vi_trgm
        ON media_segments USING gin(
          immutable_unaccent(lower(coalesce(caption_vi, ''))) gin_trgm_ops
        )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS media_segments_caption_vi_trgm`);
    await queryRunner.query(`DROP INDEX IF EXISTS media_segments_search_vector_gin`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS media_segments_search_vector_trigger ON media_segments`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS media_segments_search_vector_update()`);
    await queryRunner.query(`ALTER TABLE media_segments DROP COLUMN IF EXISTS search_vector`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS immutable_unaccent(text)`);
    // Extensions are left in place intentionally — other objects may depend on them.
  }
}
