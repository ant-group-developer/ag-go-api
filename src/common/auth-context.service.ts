import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { UserType } from './auth/user-type';

export type AuthContext = {
  userId: string;
  /** Bearer token (set for real Auth0 users; absent for service-key act-as). */
  accessToken: string;
  userType?: UserType;
  permissions?: string[];
  /** Name of the service acting on behalf of this user (set by service-key auth). */
  actingService?: string;
};

@Injectable()
export class AuthContextService {
  getContext(request: Request): AuthContext {
    if (request.authContext) {
      return request.authContext;
    }
    throw new UnauthorizedException('Authenticated user context is required');
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    authContext?: AuthContext;
    requestId?: string;
  }
}
