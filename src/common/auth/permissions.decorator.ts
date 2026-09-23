import { SetMetadata } from '@nestjs/common';
import type { GoPermission } from './permissions.constants';

export const REQUIRED_PERMISSIONS_KEY = 'requiredPermissions';
export const ANY_PERMISSIONS_KEY = 'anyPermissions';

export const RequirePermissions = (...permissions: GoPermission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

export const RequireAnyPermissions = (...permissions: GoPermission[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);
