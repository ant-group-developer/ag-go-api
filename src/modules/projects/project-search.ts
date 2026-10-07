/** Most words of a keyword that are matched; extra words are ignored. */
const MAX_SEARCH_TOKENS = 8;
/** Words at least this long also match a close spelling (typos, a missing letter). */
const FUZZY_MIN_LENGTH = 4;
/** `word_similarity` a word needs to count as a close spelling. */
const FUZZY_THRESHOLD = 0.5;

/**
 * Everything a project can be found by, lowercased and without diacritics: its name and
 * description, folder path, category, country, province and tags. Expects the outer query to
 * alias the project table as `project`.
 */
const SEARCH_DOCUMENT = `immutable_unaccent(lower(concat_ws(' ',
  project.name,
  project.description,
  (SELECT search_folder.path_text FROM folders search_folder WHERE search_folder.id = project.folder_id),
  (SELECT search_category.name FROM categories search_category WHERE search_category.id = project.category_id),
  (SELECT search_country.name FROM countries search_country WHERE search_country.id = project.country_id),
  (SELECT search_province.name FROM provinces search_province WHERE search_province.id = project.province_id),
  (SELECT string_agg(search_tag.name, ' ')
     FROM project_tags search_project_tag
     INNER JOIN tags search_tag ON search_tag.id = search_project_tag.tag_id
     WHERE search_project_tag.project_id = project.id)
)))`;

/** Lowercases and strips Vietnamese diacritics (including đ/Đ), as `immutable_unaccent` does. */
export function normalizeSearchKeyword(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The distinct words of a keyword, without punctuation. */
export function searchTokens(keyword: string): string[] {
  const words = normalizeSearchKeyword(keyword)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return [...new Set(words)].slice(0, MAX_SEARCH_TOKENS);
}

export type ProjectSearch = {
  /** Condition every listed project must meet. */
  where: string;
  /** Higher for closer matches; used to sort by relevance. */
  score: string;
  params: Record<string, string>;
};

/**
 * Accent-insensitive search across a project's name, description, folder path, category,
 * location and tags. Every word must appear somewhere (in any of those fields), either as a
 * part of a word, with the spaces of the text ignored ("hanoi" finds "Hà Nội"), or, for longer
 * words, as a close spelling ("da nangg" finds "Đà Nẵng").
 *
 * The search document is built once per project inside a lateral-like subquery instead of
 * once per word.
 */
export function buildProjectSearch(keyword: string): ProjectSearch | null {
  const tokens = searchTokens(keyword);
  if (tokens.length === 0) {
    return null;
  }
  const params: Record<string, string> = { search_keyword: tokens.join(' ') };
  const conditions = tokens.map((token, index) => {
    const name = `search_token_${index}`;
    params[name] = token;
    const exact = `strpos(search_doc.doc, :${name}) > 0 OR strpos(replace(search_doc.doc, ' ', ''), :${name}) > 0`;
    return token.length >= FUZZY_MIN_LENGTH
      ? `(${exact} OR word_similarity(:${name}, search_doc.doc) >= ${FUZZY_THRESHOLD})`
      : `(${exact})`;
  });
  return {
    where: `EXISTS (
      SELECT 1 FROM (SELECT ${SEARCH_DOCUMENT} AS doc) search_doc
      WHERE ${conditions.join(' AND ')}
    )`,
    // Name matches weigh most; a whole-keyword hit in the name ranks first.
    score: `(
      SELECT
        CASE WHEN strpos(search_doc.name, :search_keyword) > 0 THEN 2 ELSE 0 END
        + 2 * similarity(search_doc.name, :search_keyword)
        + word_similarity(:search_keyword, search_doc.doc)
      FROM (
        SELECT immutable_unaccent(lower(project.name)) AS name, ${SEARCH_DOCUMENT} AS doc
      ) search_doc
    )`,
    params,
  };
}
