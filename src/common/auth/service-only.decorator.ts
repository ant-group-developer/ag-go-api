import { SetMetadata } from '@nestjs/common';

export const SERVICE_ONLY_SCOPE_KEY = 'serviceOnlyScope';

/**
 * Marks a route that only a service may call, not a user: the request must carry an
 * `X-Service-Key` whose `SERVICE_KEYS` entry has `scope`. No `X-Act-As-User` is needed and the
 * Account API is not called; a user's Bearer token is refused. The auth context then names the
 * service (`actingService`, `serviceOnly: true`) and no user.
 *
 * Do not combine with `@RequirePermissions`: there is no user to hold permissions.
 */
export const ServiceOnly = (scope: string) => SetMetadata(SERVICE_ONLY_SCOPE_KEY, scope);
