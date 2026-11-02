import type { Request } from 'express';
import type { AuthContext } from '../../common/auth-context.service';
import type { GoPermission } from '../../common/auth/permissions.constants';
import { isAdminUserType } from '../../common/auth/user-type';

/** Who is acting, as the partners / contracts services need it (from the request's auth context). */
export type PartnerActor = Pick<AuthContext, 'userId' | 'sub' | 'userType' | 'permissions'> & {
  requestId?: string;
};

export function partnerActor(context: AuthContext, request: Request): PartnerActor {
  return {
    userId: context.userId,
    sub: context.sub,
    userType: context.userType,
    permissions: context.permissions,
    requestId: request.requestId,
  };
}

/** Administrators have every permission (as PermissionsGuard decides). */
export function hasPermission(actor: PartnerActor, permission: GoPermission): boolean {
  return isAdminUserType(actor.userType) || (actor.permissions ?? []).includes(permission);
}
