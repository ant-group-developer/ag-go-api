import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { AccountApiService } from '../../modules/account/account-api.service';
import { SystemLogService } from '../../modules/logs/system-log.service';
import type { AuthContext } from '../auth-context.service';
import { SERVICE_KEY_SCOPES_KEY } from './allow-service-key.decorator';
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
  azp?: string;
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

type ServiceKeyEntry = {
  name: string;
  sha256: string;
  scopes: string[];
};

@Injectable()
export class Auth0Guard implements CanActivate {
  private jwksCache?: JwksCache;

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    @Optional() private readonly accountApi?: AccountApiService,
    @Optional() private readonly systemLog?: SystemLogService,
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

    // ------------------------------------------------------------------
    // Service-key path: only if the route declares @AllowServiceKey AND
    // the request carries X-Service-Key.
    // ------------------------------------------------------------------
    const allowedScopes = this.reflector.getAllAndOverride<string[] | undefined>(
      SERVICE_KEY_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const rawServiceKey = request.header('x-service-key');

    if (allowedScopes?.length && rawServiceKey) {
      await this.activateServiceKey(request, rawServiceKey, allowedScopes);
      return true;
    }

    // ------------------------------------------------------------------
    // Normal Auth0 JWT path
    // ------------------------------------------------------------------
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('Bearer token is required');
    }

    const claims = await this.verifyToken(token);

    if (!claims.sub) {
      throw new UnauthorizedException('Token subject is required');
    }

    const userId = this.normalizeUserId(claims.sub);
    if (!userId) {
      throw new UnauthorizedException('Token subject is invalid');
    }

    const authContext: AuthContext = {
      userId,
      accessToken: token,
    };
    request.authContext = authContext;
    return true;
  }

  // -----------------------------------------------------------------------
  // Service-key authentication
  // -----------------------------------------------------------------------

  private async activateServiceKey(
    request: Request,
    rawKey: string,
    requiredScopes: string[],
  ): Promise<void> {
    const entry = this.resolveServiceKey(rawKey);
    if (!entry) {
      throw new UnauthorizedException('Invalid service key');
    }

    // Verify the key covers at least all required scopes for this route
    for (const scope of requiredScopes) {
      if (!entry.scopes.includes(scope)) {
        throw new ForbiddenException(`Service key does not have required scope: ${scope}`);
      }
    }

    // Require X-Act-As-User
    const actAsUserId = request.header('x-act-as-user');
    if (!actAsUserId?.trim()) {
      throw new UnauthorizedException('X-Act-As-User header is required for service-key requests');
    }
    const userId = actAsUserId.trim();

    // Load user access from Account API (cached 60 s)
    let access: { user_type: 'ADMIN' | 'USER'; permissions: string[] };
    try {
      if (!this.accountApi) {
        throw new ServiceUnavailableException('AccountApiService is not available');
      }
      access = await this.accountApi.getUserAccess(userId);
    } catch (error) {
      // Never guess — propagate 503 or turn any unexpected error into 503
      if (
        error instanceof ServiceUnavailableException ||
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException('Account API is unavailable');
    }

    // Populate auth context
    const authContext: AuthContext = {
      userId,
      accessToken: '',
      userType: access.user_type,
      permissions: access.permissions,
      actingService: entry.name,
    };
    request.authContext = authContext;

    // Audit every act-as use
    const requestId = (request as Request & { requestId?: string }).requestId;
    try {
      await this.systemLog?.write({
        level: 'info',
        category: 'service_key',
        action: 'act_as',
        message: `Service "${entry.name}" acting as user ${userId}`,
        requestId,
        userId,
        metadata: {
          service: entry.name,
          scopes: requiredScopes,
          path: request.path,
          method: request.method,
        },
      });
    } catch {
      // Audit failure must never block the request
    }
  }

  /**
   * Parses the SERVICE_KEYS env var (`[{"name":"...","sha256":"<hex>","scopes":[...]}]`),
   * hashes the incoming key with SHA-256, and finds a matching entry using constant-time
   * comparison to prevent timing attacks.
   */
  private resolveServiceKey(rawKey: string): ServiceKeyEntry | null {
    const rawJson = this.config.get<string>('SERVICE_KEYS');
    if (!rawJson?.trim()) {
      return null;
    }

    let entries: unknown[];
    try {
      entries = JSON.parse(rawJson) as unknown[];
    } catch {
      return null;
    }

    if (!Array.isArray(entries)) {
      return null;
    }

    const incomingHash = createHash('sha256').update(rawKey).digest('hex');
    const incomingBuf = Buffer.from(incomingHash, 'utf8');

    for (const entry of entries) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as Record<string, unknown>)['name'] !== 'string' ||
        typeof (entry as Record<string, unknown>)['sha256'] !== 'string' ||
        !Array.isArray((entry as Record<string, unknown>)['scopes'])
      ) {
        continue;
      }
      const e = entry as ServiceKeyEntry;
      // Constant-time compare — pad both buffers to the same length
      const storedBuf = Buffer.from(e.sha256, 'utf8');
      if (storedBuf.length !== incomingBuf.length) {
        // Different length: still do a fake compare to avoid early exit
        timingSafeEqual(incomingBuf, incomingBuf);
        continue;
      }
      if (timingSafeEqual(incomingBuf, storedBuf)) {
        return e;
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Auth0 JWT helpers
  // -----------------------------------------------------------------------

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

      const issuer = this.config.getOrThrow<string>('AUTH0_ISSUER_URL').replace(/\/+$/, '');
      const audience = this.config.getOrThrow<string>('AUTH0_AUDIENCE');

      // azp allowlist: if AUTH0_ALLOWED_CLIENT_IDS is set (non-empty), validate against
      // that list; otherwise fall back to AUTH0_CLIENT_ID for backwards compatibility.
      const allowedRaw = this.config.get<string>('AUTH0_ALLOWED_CLIENT_IDS');
      const allowedIds = allowedRaw
        ? allowedRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const fallbackClientId = this.config.getOrThrow<string>('AUTH0_CLIENT_ID');
      const allowedClientIds = allowedIds.length > 0 ? allowedIds : [fallbackClientId];

      if (
        !claims.iss ||
        claims.iss.replace(/\/+$/, '') !== issuer ||
        !this.matchesAudience(claims.aud, audience) ||
        !allowedClientIds.includes(claims.azp ?? '')
      ) {
        throw new Error('JWT issuer, audience, or client mismatch');
      }

      const now = Math.floor(Date.now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp <= now) {
        throw new Error('JWT is expired');
      }
      if (typeof claims.nbf === 'number' && claims.nbf > now) {
        throw new Error('JWT is not active');
      }

      const key = await this.getJwk(header.kid);
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

  private async getJwk(kid: string): Promise<JsonWebKey> {
    const now = Date.now();
    if (!this.jwksCache || this.jwksCache.expiresAt <= now) {
      const jwksUrl = this.config.getOrThrow<string>('AUTH0_JWKS_URL');
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

  private normalizeUserId(subject: string): string {
    return subject.startsWith('auth0|') ? subject.slice('auth0|'.length) : subject;
  }
}
