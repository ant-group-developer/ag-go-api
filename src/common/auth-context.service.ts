import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

export type AuthContext = {
  userId: string;
  groupIds: string[];
};

@Injectable()
export class AuthContextService {
  constructor(private readonly config: ConfigService) {}

  getContext(request: Request): AuthContext {
    if (request.authContext) {
      return request.authContext;
    }

    const userId = request.header('x-user-id')?.trim();
    const groupIds = (request.header('x-group-ids') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const authMode = this.config.get<string>('AUTH_MODE');
    const auth0Enabled =
      authMode === 'auth0' || (!authMode && this.config.get<string>('NODE_ENV') === 'production');
    if (auth0Enabled) {
      throw new UnauthorizedException('Authenticated user context is required');
    }

    return {
      userId: userId || this.config.get<string>('DEV_USER_ID', 'dev-user'),
      groupIds,
    };
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    authContext?: AuthContext;
    requestId?: string;
  }
}
