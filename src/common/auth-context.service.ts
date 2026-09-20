import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

export type AuthContext = {
  userId: string;
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
