import { SetMetadata } from '@nestjs/common';
import type { GoPermission } from './permissions.constants';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSIONS_KEY = 'anyPermissions';
export const ADMIN_ONLY_KEY = 'adminOnly';

export const RequirePermissions = (...permissions: GoPermission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export const RequireAnyPermissions = (...permissions: GoPermission[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);

/** Only ADMIN users, whatever permissions others are granted. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY_KEY, true);
