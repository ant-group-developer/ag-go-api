import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores each project's keyword-search document in `projects.search_text`: its name,
 * description, folder path, category, country, province and tag names, lowercased and without
 * diacritics. The project list used to build that document for every project on every search
 * (several seconds over 50k projects); now it is read from the column.
 *
 * Triggers keep the column current:
 *   - a project's own fields (name, description, folder, category, place) when it is written;
 *   - its tags when tags are linked or unlinked;
 *   - every affected project when a folder path, category, country, province or tag is renamed.
 *
 * `project_search_words` keeps every word of those documents (a few thousand at most), so a
 * word found nowhere as typed can be matched to close spellings among them ("nangg" → "nang")
 * without comparing it against every project. Words are only added: one no project uses any
 * more is offered as a spelling and simply matches nothing.
 *
 * Depends on `immutable_unaccent` and `pg_trgm` from FootageSearch2030000000000.
 */
export class ProjectSearchText2080000000000 implements MigrationInterface {
  name = 'ProjectSearchText2080000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT ''
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION project_search_text(
        p_id uuid,
        p_name text,
        p_description text,
        p_folder_id uuid,
        p_category_id uuid,
        p_country_id uuid,
        p_province_id uuid
      )
        RETURNS text
        LANGUAGE sql
        STABLE
      AS $$
        SELECT immutable_unaccent(lower(concat_ws(' ',
          p_name,
          p_description,
          (SELECT folder.path_text FROM folders folder WHERE folder.id = p_folder_id),
          (SELECT category.name FROM categories category WHERE category.id = p_category_id),
          (SELECT country.name FROM countries country WHERE country.id = p_country_id),
          (SELECT province.name FROM provinces province WHERE province.id = p_province_id),
          (SELECT string_agg(tag.name, ' ')
             FROM project_tags project_tag
             INNER JOIN tags tag ON tag.id = project_tag.tag_id
            WHERE project_tag.project_id = p_id)
        )))
      $$
    `);

    // Recomputes the given projects. It writes only search_text, so the projects trigger below
    // (which watches the source columns) does not fire again.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION refresh_project_search_text(p_ids uuid[])
        RETURNS void
        LANGUAGE sql
      AS $$
        UPDATE projects project
           SET search_text = project_search_text(
             project.id, project.name, project.description, project.folder_id,
             project.category_id, project.country_id, project.province_id)
         WHERE project.id = ANY(p_ids)
      $$
    `);

    // 1. A project's own fields.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION projects_search_text_update()
        RETURNS trigger
        LANGUAGE plpgsql
      AS $$
      BEGIN
        NEW.search_text := project_search_text(
          NEW.id, NEW.name, NEW.description, NEW.folder_id,
          NEW.category_id, NEW.country_id, NEW.province_id);
        RETURN NEW;
      END;
      $$
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS projects_search_text_trigger ON projects`);
    await queryRunner.query(`
      CREATE TRIGGER projects_search_text_trigger
        BEFORE INSERT OR UPDATE OF name, description, folder_id, category_id, country_id, province_id
        ON projects
        FOR EACH ROW EXECUTE FUNCTION projects_search_text_update()
    `);

    // 2. Tags linked or unlinked; once per statement, so a bulk import updates each project once.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION project_tags_search_text_update()
        RETURNS trigger
        LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM refresh_project_search_text(ARRAY(SELECT DISTINCT project_id FROM changed_rows));
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS project_tags_search_text_insert_trigger ON project_tags`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS project_tags_search_text_delete_trigger ON project_tags`,
    );
    await queryRunner.query(`
      CREATE TRIGGER project_tags_search_text_insert_trigger
        AFTER INSERT ON project_tags
        REFERENCING NEW TABLE AS changed_rows
        FOR EACH STATEMENT EXECUTE FUNCTION project_tags_search_text_update()
    `);
    await queryRunner.query(`
      CREATE TRIGGER project_tags_search_text_delete_trigger
        AFTER DELETE ON project_tags
        REFERENCING OLD TABLE AS changed_rows
        FOR EACH STATEMENT EXECUTE FUNCTION project_tags_search_text_update()
    `);

    // 3. Renames. Transition tables cannot be combined with a column list, so each function
    //    checks which rows actually changed the searched column.
    for (const rename of RENAMES) {
      await queryRunner.query(`
        CREATE OR REPLACE FUNCTION ${rename.table}_search_text_rename()
          RETURNS trigger
          LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM refresh_project_search_text(ARRAY(
            ${rename.affectedProjects(`
              SELECT new_row.id
                FROM new_rows new_row
                INNER JOIN old_rows old_row ON old_row.id = new_row.id
               WHERE new_row.${rename.column} IS DISTINCT FROM old_row.${rename.column}`)}
          ));
          RETURN NULL;
        END;
        $$
      `);
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS ${rename.table}_search_text_rename_trigger ON ${rename.table}`,
      );
      await queryRunner.query(`
        CREATE TRIGGER ${rename.table}_search_text_rename_trigger
          AFTER UPDATE ON ${rename.table}
          REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
          FOR EACH STATEMENT EXECUTE FUNCTION ${rename.table}_search_text_rename()
      `);
    }

    // 4. The words of every search document.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS project_search_words (word text PRIMARY KEY)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS project_search_words_trgm_idx
        ON project_search_words USING gin (word gin_trgm_ops)
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION projects_search_words_update()
        RETURNS trigger
        LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO project_search_words (word)
        SELECT DISTINCT word
          FROM regexp_split_to_table(NEW.search_text, '[^[:alnum:]]+') word
         WHERE length(word) >= ${MIN_WORD_LENGTH}
        ON CONFLICT DO NOTHING;
        RETURN NULL;
      END;
      $$
    `);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS projects_search_words_insert_trigger ON projects`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS projects_search_words_update_trigger ON projects`,
    );
    await queryRunner.query(`
      CREATE TRIGGER projects_search_words_insert_trigger
        AFTER INSERT ON projects
        FOR EACH ROW EXECUTE FUNCTION projects_search_words_update()
    `);
    await queryRunner.query(`
      CREATE TRIGGER projects_search_words_update_trigger
        AFTER UPDATE ON projects
        FOR EACH ROW
        WHEN (OLD.search_text IS DISTINCT FROM NEW.search_text)
        EXECUTE FUNCTION projects_search_words_update()
    `);

    // Backfill (the search text, then its words).
    await queryRunner.query(`
      UPDATE projects project
         SET search_text = project_search_text(
           project.id, project.name, project.description, project.folder_id,
           project.category_id, project.country_id, project.province_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS projects_search_words_insert_trigger ON projects`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS projects_search_words_update_trigger ON projects`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS projects_search_words_update()`);
    await queryRunner.query(`DROP TABLE IF EXISTS project_search_words`);
    for (const rename of RENAMES) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS ${rename.table}_search_text_rename_trigger ON ${rename.table}`,
      );
      await queryRunner.query(`DROP FUNCTION IF EXISTS ${rename.table}_search_text_rename()`);
    }
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS project_tags_search_text_insert_trigger ON project_tags`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS project_tags_search_text_delete_trigger ON project_tags`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS project_tags_search_text_update()`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS projects_search_text_trigger ON projects`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS projects_search_text_update()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS refresh_project_search_text(uuid[])`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS project_search_text(uuid, text, text, uuid, uuid, uuid, uuid)`,
    );
    await queryRunner.query(`ALTER TABLE projects DROP COLUMN IF EXISTS search_text`);
  }
}

/** Shorter words are not kept: a close spelling of one or two letters means little. */
const MIN_WORD_LENGTH = 3;

/** Tables whose renamed rows change the search text of the projects that use them. */
const RENAMES: Array<{
  table: string;
  column: string;
  /** Project ids affected by the changed rows that `changedIds` selects. */
  affectedProjects: (changedIds: string) => string;
}> = [
  {
    table: 'folders',
    column: 'path_text',
    affectedProjects: (ids) =>
      `SELECT project.id FROM projects project WHERE project.folder_id IN (${ids})`,
  },
  {
    table: 'categories',
    column: 'name',
    affectedProjects: (ids) =>
      `SELECT project.id FROM projects project WHERE project.category_id IN (${ids})`,
  },
  {
    table: 'countries',
    column: 'name',
    affectedProjects: (ids) =>
      `SELECT project.id FROM projects project WHERE project.country_id IN (${ids})`,
  },
  {
    table: 'provinces',
    column: 'name',
    affectedProjects: (ids) =>
      `SELECT project.id FROM projects project WHERE project.province_id IN (${ids})`,
  },
  {
    table: 'tags',
    column: 'name',
    affectedProjects: (ids) =>
      `SELECT DISTINCT project_tag.project_id FROM project_tags project_tag WHERE project_tag.tag_id IN (${ids})`,
  },
];
