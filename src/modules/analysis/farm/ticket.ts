// Copied from ag-farm packages/protocol v0.1.0 — keep in sync
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { IsoDateTimeSchema, JobTypeSchema, OwnerIdSchema } from './protocol';

export const TICKET_ISSUER = 'ag-farm';
export const TICKET_TYP = 'farm-ticket+jwt';

export const TicketClaimsSchema = z.strictObject({
  iss: z.literal(TICKET_ISSUER),
  sub: z.uuid(),
  jti: z.uuid(),
  job_id: z.uuid(),
  owner: OwnerIdSchema,
  type: JobTypeSchema,
  attempt: z.int().positive(),
  iat: z.int().positive(),
  exp: z.int().positive(),
});
export type TicketClaims = z.infer<typeof TicketClaimsSchema>;

// Suppress unused import warning — IsoDateTimeSchema is used by re-exported modules
void IsoDateTimeSchema;

type KeyInput = string | KeyObject;

function toPublicKey(key: KeyInput): KeyObject {
  if (typeof key === 'string') {
    // Accept literal \n in PEM values (common in env vars)
    const pem = key.replace(/\\n/g, '\n');
    return createPublicKey(pem);
  }
  return key;
}

export class TicketError extends Error {
  constructor(
    readonly reason:
      'malformed' | 'bad_header' | 'bad_signature' | 'bad_claims' | 'expired' | 'wrong_owner',
    message: string,
  ) {
    super(message);
    this.name = 'TicketError';
  }
}

export type VerifyTicketOptions = {
  owner: string;
  now?: number;
  clockToleranceSeconds?: number;
};

export function verifyTicket(
  token: string,
  publicKey: KeyInput,
  options: VerifyTicketOptions,
): TicketClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new TicketError('malformed', 'Ticket is not a JWT');
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  let rawClaims: unknown;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as {
      alg?: unknown;
      typ?: unknown;
    };
    rawClaims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch {
    throw new TicketError('malformed', 'Ticket is not valid base64url JSON');
  }
  if (header.alg !== 'EdDSA' || header.typ !== TICKET_TYP) {
    throw new TicketError('bad_header', 'Unsupported ticket header');
  }

  const signature = Buffer.from(encodedSignature, 'base64url');
  const ok = verify(
    null,
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    toPublicKey(publicKey),
    signature,
  );
  if (!ok) {
    throw new TicketError('bad_signature', 'Ticket signature mismatch');
  }

  const parsed = TicketClaimsSchema.safeParse(rawClaims);
  if (!parsed.success) {
    throw new TicketError('bad_claims', 'Ticket claims are invalid');
  }
  const claims = parsed.data;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 30;
  if (claims.exp + tolerance <= now) {
    throw new TicketError('expired', 'Ticket is expired');
  }
  if (claims.owner !== options.owner) {
    throw new TicketError('wrong_owner', 'Ticket belongs to another owner');
  }
  return claims;
}

export function extractTicket(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.trim().split(/\s+/, 2);
  return scheme?.toLowerCase() === 'ticket' && token ? token : null;
}
