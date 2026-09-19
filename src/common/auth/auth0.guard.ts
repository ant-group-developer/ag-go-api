import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createPublicKey, verify } from 'node:crypto';
import type { AuthContext } from '../auth-context.service';
import { IS_PUBLIC_KEY } from './public.decorator';

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtClaims = {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
};

type JsonWebKey = {
  alg?: string;
  e: string;
  kid?: string;
  kty: string;
  n: string;
  use?: string;
};

type JwksResponse = {
  keys?: JsonWebKey[];
};

type JwksCache = {
  expiresAt: number;
  keys: JsonWebKey[];
};

@Injectable()
export class Auth0Guard implements CanActivate {
  private jwksCache?: JwksCache;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!this.isAuth0Enabled()) {
      return true;
    }

    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Bearer token is required');
    }

    const claims = await this.verifyToken(token);
    const groupClaim = this.config.get<string>('AUTH0_GROUPS_CLAIM', 'https://ag-go/groups');
    const groupIds = this.readStringArray(claims[groupClaim] ?? claims.groups);

    if (!claims.sub) {
      throw new UnauthorizedException('Token subject is required');
    }

    const authContext: AuthContext = {
      userId: claims.sub,
      groupIds,
    };
    request.authContext = authContext;
    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const value = request.header('authorization');
    if (!value) {
      return undefined;
    }

    const [scheme, token] = value.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
  }

  private async verifyToken(token: string): Promise<JwtClaims> {
    try {
      const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');
      if (!encodedHeader || !encodedClaims || !encodedSignature) {
        throw new Error('Malformed JWT');
      }

      const header = this.decode<JwtHeader>(encodedHeader);
      const claims = this.decode<JwtClaims>(encodedClaims);
      if (header.alg !== 'RS256' || !header.kid) {
        throw new Error('Unsupported JWT header');
      }

      const issuer = this.config.get<string>('AUTH0_ISSUER_URL')?.replace(/\/+$/, '');
      const audience = this.config.get<string>('AUTH0_AUDIENCE');
      if (!issuer || !audience) {
        throw new Error('Auth0 configuration is incomplete');
      }

      if (
        !claims.iss ||
        claims.iss.replace(/\/+$/, '') !== issuer ||
        !this.matchesAudience(claims.aud, audience)
      ) {
        throw new Error('JWT issuer or audience mismatch');
      }

      const now = Math.floor(Date.now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp <= now) {
        throw new Error('JWT is expired');
      }
      if (typeof claims.nbf === 'number' && claims.nbf > now) {
        throw new Error('JWT is not active');
      }

      const key = await this.getJwk(header.kid, issuer);
      const publicKey = createPublicKey({ key, format: 'jwk' });
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      const signature = Buffer.from(encodedSignature, 'base64url');
      if (!verify('RSA-SHA256', Buffer.from(signingInput), publicKey, signature)) {
        throw new Error('JWT signature mismatch');
      }

      return claims;
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private async getJwk(kid: string, issuer: string): Promise<JsonWebKey> {
    const now = Date.now();
    if (!this.jwksCache || this.jwksCache.expiresAt <= now) {
      const configuredUrl = this.config.get<string>('AUTH0_JWKS_URL');
      const jwksUrl = configuredUrl || `${issuer}/.well-known/jwks.json`;
      const response = await fetch(jwksUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`JWKS request failed with status ${response.status}`);
      }

      const body = (await response.json()) as JwksResponse;
      this.jwksCache = {
        expiresAt: now + 5 * 60 * 1000,
        keys: body.keys ?? [],
      };
    }

    const key = this.jwksCache.keys.find(
      (candidate) => candidate.kid === kid && candidate.kty === 'RSA',
    );
    if (!key) {
      throw new Error('Signing key not found');
    }
    return key;
  }

  private decode<T>(value: string): T {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  }

  private matchesAudience(value: JwtClaims['aud'], expected: string): boolean {
    return Array.isArray(value) ? value.includes(expected) : value === expected;
  }

  private readStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
    return typeof value === 'string' ? [value] : [];
  }

  private isAuth0Enabled(): boolean {
    const mode = this.config.get<string>('AUTH_MODE');
    return mode ? mode === 'auth0' : this.config.get<string>('NODE_ENV') === 'production';
  }
}
