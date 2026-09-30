/**
 * Utilities for reading ag-farm hub API responses.
 *
 * The hub is migrating from raw JSON bodies to a standard envelope:
 *   success: { data, requestId, timestamp, success: true }
 *   error:   { data: null, success: false, error: { code, message, details?, fieldErrors? } }
 * HTTP status codes are unchanged by the migration.
 *
 * These helpers let FarmClient work before and after the hub switches, and are applied
 * before any zod / TypeScript-type parsing so that schemas only see the inner data.
 */

interface SuccessEnvelope {
  success: true;
  data: unknown;
  requestId: string;
}

interface ErrorEnvelope {
  success: false;
  data: null;
  requestId: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
    fieldErrors?: unknown;
  };
}

type ApiEnvelope = SuccessEnvelope | ErrorEnvelope;

/**
 * Returns `true` when `body` looks like the ag-farm envelope:
 * an object with boolean `success`, a `data` key, and a string `requestId`.
 */
export function isApiEnvelope(body: unknown): body is ApiEnvelope {
  if (typeof body !== 'object' || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj['success'] === 'boolean' && 'data' in obj && typeof obj['requestId'] === 'string'
  );
}

/**
 * When `body` is a successful ag-farm envelope (`success: true`), returns the `data` field.
 * Otherwise returns `body` unchanged — covering both legacy raw bodies and error envelopes
 * (error envelopes pair with a non-OK HTTP status and are handled by {@link readApiError}).
 */
export function unwrapApiResponse(body: unknown): unknown {
  if (isApiEnvelope(body) && body.success) {
    return body.data;
  }
  return body;
}

/**
 * Builds a descriptive `Error` for a non-OK farm hub response.
 * Prefers `error.code` / `error.message` from the error envelope;
 * falls back to the raw body text for legacy error shapes.
 */
export function readApiError(status: number, path: string, body: unknown): Error {
  if (isApiEnvelope(body) && !body.success) {
    const eb = body as ErrorEnvelope;
    return new Error(`Farm ${path} returned ${status}: [${eb.error.code}] ${eb.error.message}`);
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Error(`Farm ${path} returned ${status}: ${text}`);
}
