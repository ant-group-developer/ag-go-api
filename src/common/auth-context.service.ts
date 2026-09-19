import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

export type AuthContext = {
  userId: string;
  groupIds: string[];
};

@Injectable()
export class AuthContextService {
  getContext(request: Request): AuthContext {
    const userId = request.header('x-user-id')?.trim();
    const groupIds = (request.header('x-group-ids') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (process.env.NODE_ENV === 'production' && !userId) {
      throw new UnauthorizedException('Authenticated user context is required');
    }

    return {
      userId: userId || process.env.DEV_USER_ID || 'dev-user',
      groupIds,
    };
  }
}
