import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Auth0Guard } from './auth0.guard';

function createContext(request: Request): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function createRequest(headers: Record<string, string>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

describe('Auth0Guard', () => {
  it('rejects requests without a bearer token', async () => {
    const guard = new Auth0Guard(
      new Reflector(),
      new ConfigService({
        AUTH0_ISSUER_URL: 'https://tenant.example.com/',
        AUTH0_AUDIENCE: 'ag-go-api',
        AUTH0_CLIENT_ID: 'client-id',
        AUTH0_JWKS_URL: 'https://tenant.example.com/.well-known/jwks.json',
      }),
    );

    await expect(guard.canActivate(createContext(createRequest({})))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('validates an Auth0-style RS256 token and extracts the normalized user id', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://tenant.example.com';
    const audience = 'ag-go-api';
    const clientId = 'client-id';
    const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' };
    const claims = {
      sub: 'auth0|user-1',
      iss: issuer,
      aud: audience,
      azp: clientId,
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const encodedHeader = encode(header);
    const encodedClaims = encode(claims);
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString(
      'base64url',
    );
    const token = `${signingInput}.${signature}`;
    const jwk = publicKey.export({ format: 'jwk' }) as {
      e: string;
      kty: string;
      n: string;
    };
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [{ ...jwk, alg: 'RS256', kid: 'test-key', use: 'sig' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const guard = new Auth0Guard(
      new Reflector(),
      new ConfigService({
        AUTH0_ISSUER_URL: issuer,
        AUTH0_AUDIENCE: audience,
        AUTH0_CLIENT_ID: clientId,
        AUTH0_JWKS_URL: `${issuer}/.well-known/jwks.json`,
      }),
    );
    const request = createRequest({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.authContext).toEqual({
      userId: 'user-1',
    });

    fetchSpy.mockRestore();
  });

  it('rejects a token issued to a different client application', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const issuer = 'https://tenant.example.com';
    const audience = 'ag-go-api';
    const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT' };
    const claims = {
      sub: 'auth0|user-1',
      iss: issuer,
      aud: audience,
      azp: 'another-client-id',
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const encodedHeader = encode(header);
    const encodedClaims = encode(claims);
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString(
      'base64url',
    );
    const token = `${signingInput}.${signature}`;
    const jwk = publicKey.export({ format: 'jwk' }) as {
      e: string;
      kty: string;
      n: string;
    };
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [{ ...jwk, alg: 'RS256', kid: 'test-key', use: 'sig' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const guard = new Auth0Guard(
      new Reflector(),
      new ConfigService({
        AUTH0_ISSUER_URL: issuer,
        AUTH0_AUDIENCE: audience,
        AUTH0_CLIENT_ID: 'expected-client-id',
        AUTH0_JWKS_URL: `${issuer}/.well-known/jwks.json`,
      }),
    );

    await expect(
      guard.canActivate(createContext(createRequest({ authorization: `Bearer ${token}` }))),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    fetchSpy.mockRestore();
  });
});
