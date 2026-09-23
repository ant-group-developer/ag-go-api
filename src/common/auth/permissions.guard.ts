import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccountApiService } from '../../modules/account/account-api.service';
import { AuthContextService } from '../auth-context.service';
import type { GoPermission } from './permissions.constants';
import { ANY_PERMISSIONS_KEY, REQUIRED_PERMISSIONS_KEY } from './permissions.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { isAdminUserType } from './user-type';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accountApi: AccountApiService,
    private readonly authContext: AuthContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const required = this.reflector.getAllAndOverride<GoPermission[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const anyRequired = this.reflector.getAllAndOverride<GoPermission[]>(ANY_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length && !anyRequired?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authContext = this.authContext.getContext(request);
    const currentUser =
      authContext.permissions && authContext.userType
        ? {
            user_type: authContext.userType,
            permissions: authContext.permissions,
          }
        : await this.loadCurrentUser(request);

    if (!currentUser.user_type) {
      throw new UnauthorizedException('Account permission context is unavailable');
    }

    if (isAdminUserType(currentUser.user_type)) {
      return true;
    }

    if (!currentUser.permissions) {
      throw new UnauthorizedException('Account permission context is unavailable');
    }

    const granted = new Set(currentUser.permissions);
    const missing = required?.filter((permission) => !granted.has(permission)) ?? [];
    const hasAny = anyRequired?.some((permission) => granted.has(permission)) ?? true;
    if (missing.length > 0 || !hasAny) {
      if (missing.length > 0 && !hasAny) {
        throw new ForbiddenException(
          `Missing required permission(s): ${missing.join(', ')}; requires any of: ${anyRequired?.join(', ')}`,
        );
      }
      if (missing.length > 0) {
        throw new ForbiddenException(`Missing required permission(s): ${missing.join(', ')}`);
      }
      throw new ForbiddenException(
        `Missing one of the required permissions: ${anyRequired?.join(', ')}`,
      );
    }
    return true;
  }

  private async loadCurrentUser(request: Request) {
    const context = this.authContext.getContext(request);
    if (!context.accessToken) {
      throw new UnauthorizedException('Bearer token is required');
    }

    const currentUser = await this.accountApi.getCurrentUser(context.accessToken);
    context.userType = currentUser.user_type;
    context.permissions = currentUser.permissions;
    return currentUser;
  }
}
