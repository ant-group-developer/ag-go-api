import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Auth0Guard } from './auth0.guard';

// system-log.service imports @nestjs/typeorm (ESM); mock it so Jest can load the guard.
jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));

function createContext(request: Request): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as ExecutionContext;
}

function createRequest(headers: Record<string, string>, extra: Partial<Request> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    path: '/test',
    method: 'GET',
    ...extra,
  } as unknown as Request;
}

/** Build a valid RS256 JWT signed with privateKey. */
function buildJwt(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  claims: Record<string, unknown>,
): string {
  const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' };
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const encodedHeader = encode(header);
  const encodedClaims = encode(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function mockJwks(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']) {
  const jwk = publicKey.export({ format: 'jwk' }) as { e: string; kty: string; n: string };
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        keys: [{ ...jwk, alg: 'RS256', kid: 'test-key', use: 'sig' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

/** Create a guard with a Reflector that returns given metadata for the handler. */
function buildGuard(
  configValues: Record<string, unknown>,
  handlerMetadata: Record<string, unknown> = {},
  mocks: { accountApi?: Partial<{ getUserAccess: jest.Mock }>; systemLog?: object } = {},
) {
  const reflector = {
    getAllAndOverride: (key: string) => handlerMetadata[key] ?? undefined,
  } as unknown as Reflector;

  return new Auth0Guard(
    reflector,
    new ConfigService(configValues),
    mocks.accountApi as never,
    mocks.systemLog as never,
  );
}

const baseConfig = {
  AUTH0_ISSUER_URL: 'https://tenant.example.com/',
  AUTH0_AUDIENCE: 'ag-go-api',
  AUTH0_CLIENT_ID: 'client-id',
  AUTH0_JWKS_URL: 'https://tenant.example.com/.well-known/jwks.json',
};

describe('Auth0Guard', () => {
  // -------------------------------------------------------------------------
  // Existing JWT path
  // -------------------------------------------------------------------------

  it('rejects requests without a bearer token', async () => {
    const guard = buildGuard(baseConfig);
    await expect(guard.canActivate(createContext(createRequest({})))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('validates an Auth0-style RS256 token and extracts the normalized user id', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://tenant.example.com';
    const audience = 'ag-go-api';
    const clientId = 'client-id';
    const claims = {
      sub: 'auth0|user-1',
      iss: issuer,
      aud: audience,
      azp: clientId,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const token = buildJwt(privateKey, claims);
    const fetchSpy = mockJwks(publicKey);

    const guard = buildGuard({ ...baseConfig, AUTH0_CLIENT_ID: clientId });
    const request = createRequest({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.authContext).toEqual({ userId: 'user-1', accessToken: token });

    fetchSpy.mockRestore();
  });

  it('rejects a token issued to a different client application', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://tenant.example.com';
    const token = buildJwt(privateKey, {
      sub: 'auth0|user-1',
      iss: issuer,
      aud: 'ag-go-api',
      azp: 'another-client-id',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const fetchSpy = mockJwks(publicKey);
    const guard = buildGuard({ ...baseConfig, AUTH0_CLIENT_ID: 'expected-client-id' });

    await expect(
      guard.canActivate(createContext(createRequest({ authorization: `Bearer ${token}` }))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // azp allowlist
  // -------------------------------------------------------------------------

  it('accepts a token whose azp is in AUTH0_ALLOWED_CLIENT_IDS', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://tenant.example.com';
    const token = buildJwt(privateKey, {
      sub: 'user-2',
      iss: issuer,
      aud: 'ag-go-api',
      azp: 'studio-client',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const fetchSpy = mockJwks(publicKey);
    const guard = buildGuard({
      ...baseConfig,
      AUTH0_ALLOWED_CLIENT_IDS: 'web-client,studio-client',
    });
    const request = createRequest({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.authContext?.userId).toBe('user-2');
    fetchSpy.mockRestore();
  });

  it('rejects a token whose azp is not in AUTH0_ALLOWED_CLIENT_IDS', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://tenant.example.com';
    const token = buildJwt(privateKey, {
      sub: 'user-3',
      iss: issuer,
      aud: 'ag-go-api',
      azp: 'unknown-client',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const fetchSpy = mockJwks(publicKey);
    const guard = buildGuard({
      ...baseConfig,
      AUTH0_ALLOWED_CLIENT_IDS: 'web-client,studio-client',
    });

    await expect(
      guard.canActivate(createContext(createRequest({ authorization: `Bearer ${token}` }))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Service-key path
  // -------------------------------------------------------------------------

  const SERVICE_KEYS_JSON = (rawKey: string) =>
    JSON.stringify([
      {
        name: 'studio',
        sha256: createHash('sha256').update(rawKey).digest('hex'),
        scopes: ['footage:read', 'footage:resolve'],
      },
    ]);

  it('ignores X-Service-Key on a route that has no @AllowServiceKey decorator', async () => {
    const guard = buildGuard(baseConfig); // no serviceKeyScopes metadata
    // Route has no allowedScopes, so service-key header is ignored and Bearer is required
    await expect(
      guard.canActivate(
        createContext(createRequest({ 'x-service-key': 'any-key', 'x-act-as-user': 'u1' })),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException); // missing bearer → 401
  });

  it('rejects wrong service key', async () => {
    const raw = 'correct-key';
    const guard = buildGuard(
      { ...baseConfig, SERVICE_KEYS: SERVICE_KEYS_JSON(raw) },
      { serviceKeyScopes: ['footage:read'] },
    );
    await expect(
      guard.canActivate(
        createContext(createRequest({ 'x-service-key': 'wrong-key', 'x-act-as-user': 'u1' })),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when key does not have required scope', async () => {
    const raw = 'my-key';
    const guard = buildGuard(
      { ...baseConfig, SERVICE_KEYS: SERVICE_KEYS_JSON(raw) },
      { serviceKeyScopes: ['footage:admin'] }, // scope not in key
    );
    await expect(
      guard.canActivate(
        createContext(createRequest({ 'x-service-key': raw, 'x-act-as-user': 'u1' })),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when X-Act-As-User header is missing', async () => {
    const raw = 'my-key';
    const guard = buildGuard(
      { ...baseConfig, SERVICE_KEYS: SERVICE_KEYS_JSON(raw) },
      { serviceKeyScopes: ['footage:read'] },
    );
    await expect(
      guard.canActivate(createContext(createRequest({ 'x-service-key': raw }))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when Account API getUserAccess fails', async () => {
    const raw = 'my-key';
    const { ServiceUnavailableException } = await import('@nestjs/common');
    const getUserAccess = jest.fn().mockRejectedValue(new ServiceUnavailableException('down'));
    const guard = buildGuard(
      { ...baseConfig, SERVICE_KEYS: SERVICE_KEYS_JSON(raw) },
      { serviceKeyScopes: ['footage:read'] },
      { accountApi: { getUserAccess }, systemLog: { write: jest.fn() } },
    );
    await expect(
      guard.canActivate(
        createContext(createRequest({ 'x-service-key': raw, 'x-act-as-user': 'user1' })),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('populates auth context for valid service key + act-as', async () => {
    const raw = 'my-key';
    const getUserAccess = jest
      .fn()
      .mockResolvedValue({ user_type: 'USER', permissions: ['go.footage.search'] });
    const systemLog = { write: jest.fn().mockResolvedValue(undefined) };
    const guard = buildGuard(
      { ...baseConfig, SERVICE_KEYS: SERVICE_KEYS_JSON(raw) },
      { serviceKeyScopes: ['footage:read'] },
      { accountApi: { getUserAccess }, systemLog },
    );
    const request = createRequest({ 'x-service-key': raw, 'x-act-as-user': 'user-abc' });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.authContext).toMatchObject({
      userId: 'user-abc',
      userType: 'USER',
      permissions: ['go.footage.search'],
      actingService: 'studio',
    });
    expect(systemLog.write).toHaveBeenCalled();
  });

  it('PermissionsGuard sees permissions from act-as context (user missing permission → 403)', async () => {
    // This test uses PermissionsGuard directly to verify it reads the pre-populated context.
    const { ForbiddenException: FE } = await import('@nestjs/common');
    const { PermissionsGuard } = await import('./permissions.guard');
    const { GO_PERMISSIONS } = await import('./permissions.constants');

    // Fake AuthContextService that returns a pre-built context
    const fakeAuthCtx = {
      getContext: () => ({
        userId: 'u1',
        accessToken: '',
        userType: 'USER' as const,
        permissions: ['go.footage.search'], // does NOT have go.footage.produce
        actingService: 'studio',
      }),
    };

    const requiredPermKey = 'requiredPermissions';
    const reflector = {
      getAllAndOverride: (key: string) => {
        if (key === requiredPermKey) return [GO_PERMISSIONS.FOOTAGE_PRODUCE];
        if (key === 'isPublic') return false;
        return undefined;
      },
    } as unknown as Reflector;

    const guard = new PermissionsGuard(reflector, null as never, fakeAuthCtx as never);

    await expect(guard.canActivate(createContext(createRequest({})))).rejects.toBeInstanceOf(FE);
  });
});
