/** Most words of a keyword that are matched; extra words are ignored. */
const MAX_SEARCH_TOKENS = 8;
/** Words at least this long may match a close spelling (typos, a missing letter). */
const FUZZY_MIN_LENGTH = 4;
/** Most close spellings tried for one word. */
const MAX_CLOSE_SPELLINGS = 10;

/**
 * Close spellings of a word among the words of all search documents, closest first. `<%` is
 * pg_trgm's word similarity at its default threshold (0.6), served by the table's trigram index.
 */
export const CLOSE_SPELLINGS_SQL = `
  SELECT word FROM project_search_words
  WHERE $1 <% word
  ORDER BY word_similarity($1, word) DESC, word
  LIMIT ${MAX_CLOSE_SPELLINGS}`;

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

/** Whether a word is long enough to be matched by a close spelling when found nowhere as typed. */
export function canMatchCloseSpelling(token: string): boolean {
  return token.length >= FUZZY_MIN_LENGTH;
}

/**
 * True when `projects.search_text` holds the word exactly as typed (as part of a word). Expects
 * the project table aliased as `project` and the word in the parameter `param`.
 */
export function typedTokenCondition(param: string): string {
  return `strpos(project.search_text, :${param}) > 0`;
}

/** Like `typedTokenCondition`, or with the spaces of the text ignored ("hanoi" finds "Hà Nội"). */
function tokenCondition(param: string): string {
  return `(${typedTokenCondition(param)}
    OR strpos(replace(project.search_text, ' ', ''), :${param}) > 0)`;
}

export type ProjectSearch = {
  /** Condition every listed project must meet. */
  where: string;
  params: Record<string, string>;
};

/**
 * Accent-insensitive search across a project's name, description, folder path, category,
 * location and tags, read from `projects.search_text` (kept current by triggers). Every word
 * must appear somewhere (in any of those fields).
 *
 * `closeSpellings` maps a word found nowhere as typed to known words spelled closely, which it
 * also matches ("da nangg" finds "Đà Nẵng"). Only such words get them: given to every word they
 * would flood the list with near misses.
 */
export function buildProjectSearch(
  tokens: string[],
  closeSpellings: ReadonlyMap<string, string[]> = new Map(),
): ProjectSearch | null {
  if (tokens.length === 0) {
    return null;
  }
  const params: Record<string, string> = {};
  const conditions = tokens.map((token, index) => {
    const name = `search_token_${index}`;
    params[name] = token;
    const alternatives = (closeSpellings.get(token) ?? []).map((word, alternative) => {
      const alternativeName = `${name}_${alternative}`;
      params[alternativeName] = word;
      return typedTokenCondition(alternativeName);
    });
    return alternatives.length
      ? `(${[tokenCondition(name), ...alternatives].join(' OR ')})`
      : tokenCondition(name);
  });
  return { where: conditions.join(' AND '), params };
}
