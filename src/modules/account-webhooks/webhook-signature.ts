import { createHmac, timingSafeEqual } from 'node:crypto';

/** AG Account webhooks: headers and signature (ag-account-server webhook-signature.ts). */
export const ACCOUNT_WEBHOOK_HEADERS = {
  EVENT_ID: 'x-agaccount-event-id',
  TIMESTAMP: 'x-agaccount-timestamp',
  SIGNATURE: 'x-agaccount-signature',
} as const;

/** A request older or newer than this is refused (replay). */
export const ACCOUNT_WEBHOOK_MAX_SKEW_SECONDS = 5 * 60;

const PREFIX = 'sha256=';

/** `sha256=` + hex HMAC-SHA256(secret, `${timestamp}.${body}`), over the exact bytes received. */
export function signAccountWebhook(secret: string, timestamp: string, body: Buffer): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  return `${PREFIX}${digest}`;
}

/**
 * Null when the signature and timestamp are valid, else the reason (for logs only, never sent
 * back). Compares in constant time.
 */
export function accountWebhookRejectReason(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: Buffer | undefined;
  nowSeconds?: number;
}): string | null {
  const timestamp = input.timestamp?.trim();
  const signature = input.signature?.trim().toLowerCase();
  if (!timestamp || !signature || !signature.startsWith(PREFIX)) {
    return 'missing timestamp or signature';
  }
  if (!input.body) {
    return 'missing raw body';
  }
  if (!/^\d+$/.test(timestamp)) {
    return 'invalid timestamp';
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = Math.abs(now - Number(timestamp));
  if (skew > ACCOUNT_WEBHOOK_MAX_SKEW_SECONDS) {
    return `timestamp skewed by ${skew} s`;
  }
  const expected = Buffer.from(signAccountWebhook(input.secret, timestamp, input.body), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return 'signature mismatch';
  }
  return null;
}
