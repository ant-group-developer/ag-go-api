/**
 * Token subject of an AG Go user id. AG Go ids are the subject without `auth0|` (Auth0 database
 * users); other providers keep their prefix (`google-oauth2|…`), so an id with `|` is already one.
 */
export function subjectOfUserId(userId: string): string {
  return userId.includes('|') ? userId : `auth0|${userId}`;
}
