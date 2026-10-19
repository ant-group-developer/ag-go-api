import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { GO_PERMISSIONS } from './permissions.constants';
import { ADMIN_ONLY_KEY } from './permissions.decorator';
import { PermissionsGuard } from './permissions.guard';
import { USER_TYPES, type UserType } from './user-type';

const context = {
  getHandler: () => undefined,
  getClass: () => undefined,
  switchToHttp: () => ({ getRequest: () => ({}) }),
} as unknown as ExecutionContext;

function buildGuard(metadata: Record<string, unknown>, userType: UserType) {
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  const authContext = {
    getContext: () => ({
      userId: 'u1',
      accessToken: 'token',
      userType,
      // Every permission: admin-only routes must not be reachable through permissions.
      permissions: Object.values(GO_PERMISSIONS),
    }),
  };
  return new PermissionsGuard(reflector, null as never, authContext as never);
}

describe('PermissionsGuard admin-only routes', () => {
  it('lets an admin in', async () => {
    const guard = buildGuard({ [ADMIN_ONLY_KEY]: true }, USER_TYPES.ADMIN);

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('refuses a user, whatever permissions they have', async () => {
    const guard = buildGuard({ [ADMIN_ONLY_KEY]: true }, USER_TYPES.USER);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
