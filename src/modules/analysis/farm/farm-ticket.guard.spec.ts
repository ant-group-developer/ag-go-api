import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { KeyObject } from 'node:crypto';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Repository } from 'typeorm';
import type { AnalysisFarmJobEntity } from '../../../database/entities/analysis-farm-job.entity';
import { FarmTicketGuard } from './farm-ticket.guard';
import type { TicketClaims } from './ticket';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
}));

// Ed25519 key pair shared across all tests in this file
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

/** Signs a minimal valid ticket with optional claim overrides. */
function makeTicket(privateK: KeyObject, overrides: Partial<TicketClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: TicketClaims = {
    iss: 'ag-farm',
    sub: randomUUID(),
    jti: randomUUID(),
    job_id: randomUUID(),
    owner: 'ag-go',
    type: 'scan.extract',
    attempt: 1,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'farm-ticket+jwt' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = sign(null, Buffer.from(`${header}.${payload}`), privateK);
  return `${header}.${payload}.${Buffer.from(sig).toString('base64url')}`;
}

/** Builds a guard with a mocked repo returning `job` (null = not found). */
function makeGuard(
  job: AnalysisFarmJobEntity | null,
  pubKeyPem: string | null = PUBLIC_KEY_PEM,
): FarmTicketGuard {
  // Use null (not undefined) to mean "key not configured"; undefined triggers JS default params
  const config = {
    get: jest.fn().mockReturnValue(pubKeyPem === null ? undefined : pubKeyPem),
  } as unknown as ConfigService;
  const repo = {
    findOne: jest.fn().mockResolvedValue(job),
  } as unknown as Repository<AnalysisFarmJobEntity>;
  return new FarmTicketGuard(config, repo);
}

/** Wraps an authorization value into a minimal ExecutionContext. */
function makeContext(authorization: string | undefined): ExecutionContext {
  const req = { headers: { authorization } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const STUB_JOB: AnalysisFarmJobEntity = {
  farmJobId: randomUUID(),
  analysisId: randomUUID(),
  type: 'scan.extract',
  chunk: null,
  status: 'submitted',
  error: null,
  submittedAt: new Date(),
  ingestedAt: null,
  lockedUntil: null,
};

describe('FarmTicketGuard', () => {
  it('passes a valid ticket and attaches claims + job to the request', async () => {
    const jobId = randomUUID();
    const job = { ...STUB_JOB, farmJobId: jobId };
    const token = makeTicket(privateKey, { job_id: jobId });
    const guard = makeGuard(job);
    const req = { headers: { authorization: `Ticket ${token}` } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect((req as Record<string, unknown>)['farmTicketClaims']).toBeDefined();
    expect((req as Record<string, unknown>)['farmJob']).toBe(job);
  });

  it('throws 401 when the Authorization header is absent', async () => {
    const guard = makeGuard(null);
    await expect(guard.canActivate(makeContext(undefined))).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when the Authorization scheme is not "Ticket"', async () => {
    const guard = makeGuard(null);
    const token = makeTicket(privateKey);
    await expect(guard.canActivate(makeContext(`Bearer ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 for a malformed token (too few parts)', async () => {
    const guard = makeGuard(STUB_JOB);
    await expect(guard.canActivate(makeContext('Ticket not.a.valid'))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 for an expired ticket (exp in the past)', async () => {
    const past = Math.floor(Date.now() / 1000) - 400;
    const token = makeTicket(privateKey, { exp: past });
    const guard = makeGuard(STUB_JOB);
    await expect(guard.canActivate(makeContext(`Ticket ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 when the ticket owner is not ag-go', async () => {
    const token = makeTicket(privateKey, { owner: 'ag-studio' as 'ag-go' });
    const guard = makeGuard(STUB_JOB);
    await expect(guard.canActivate(makeContext(`Ticket ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 for a bad signature (signed with a different key)', async () => {
    const { privateKey: otherKey } = generateKeyPairSync('ed25519');
    const token = makeTicket(otherKey); // signed with other key, verified against publicKey
    const guard = makeGuard(STUB_JOB);
    await expect(guard.canActivate(makeContext(`Ticket ${token}`))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 403 when the farm job id is not in the database', async () => {
    const token = makeTicket(privateKey);
    const guard = makeGuard(null); // repo returns null
    await expect(guard.canActivate(makeContext(`Ticket ${token}`))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws 403 when the job was already ingested', async () => {
    const jobId = randomUUID();
    const ingestedJob = { ...STUB_JOB, farmJobId: jobId, ingestedAt: new Date() };
    const token = makeTicket(privateKey, { job_id: jobId });
    const guard = makeGuard(ingestedJob);
    await expect(guard.canActivate(makeContext(`Ticket ${token}`))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws 403 when FARM_TICKET_PUBLIC_KEY is not configured', async () => {
    const token = makeTicket(privateKey);
    const guard = makeGuard(STUB_JOB, null); // null = not configured
    await expect(guard.canActivate(makeContext(`Ticket ${token}`))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
