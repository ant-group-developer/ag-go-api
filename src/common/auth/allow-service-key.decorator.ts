import { SetMetadata } from '@nestjs/common';

export const SERVICE_KEY_SCOPES_KEY = 'serviceKeyScopes';

/**
 * Marks a route as accepting service-key authentication in addition to Auth0 JWT.
 *
 * When a request arrives with an `X-Service-Key` header on a route decorated with
 * `@AllowServiceKey(...scopes)`, Auth0Guard will verify the key against the
 * `SERVICE_KEYS` env list, require the matching scope, load the act-as user's
 * permissions via Account API, and populate the auth context instead of the normal
 * JWT flow.
 *
 * Routes WITHOUT this decorator completely ignore the `X-Service-Key` header.
 */
export const AllowServiceKey = (...scopes: string[]) => SetMetadata(SERVICE_KEY_SCOPES_KEY, scopes);
