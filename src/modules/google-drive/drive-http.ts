import { pipeline, Readable, Transform } from 'node:stream';

export type DriveTokenGrant = { accessToken: string; expiresAt: Date };

/** Getting a Drive access token failed: the batch should retry later instead of failing its files. */
export class DriveAuthError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DriveAuthError';
  }
}

/** Refresh this long before Google's expiry, so a request never starts with a dying token. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** A Drive access token that refreshes itself, so imports running longer than an hour keep working. */
export class DriveAccessToken {
  private grant?: DriveTokenGrant;

  constructor(
    private readonly refresh: () => Promise<DriveTokenGrant>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    if (!this.grant || this.grant.expiresAt.getTime() - this.now() <= REFRESH_MARGIN_MS) {
      try {
        this.grant = await this.refresh();
      } catch (error) {
        throw new DriveAuthError(
          `Google Drive access token refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
    return this.grant.accessToken;
  }

  /** Forces the next get() to refresh, e.g. after Google rejected the token with 401. */
  invalidate(): void {
    this.grant = undefined;
  }
}

/** Calls the Drive API with the current token, refreshing it and retrying once on 401. */
export async function driveFetch(
  token: DriveAccessToken,
  url: string,
  init: Pick<RequestInit, 'signal'> = {},
): Promise<Response> {
  const send = async () =>
    fetch(url, { ...init, headers: { Authorization: `Bearer ${await token.get()}` } });
  const response = await send();
  if (response.status !== 401) {
    return response;
  }
  await response.body?.cancel().catch(() => undefined);
  token.invalidate();
  return send();
}

/**
 * Passes `source` through, failing it when no data arrives for `idleMs`. Unlike a fixed
 * timeout this lets large files take as long as they need while still catching a stalled
 * download (or a stalled upload, which stops reading). `onIdle` runs first, e.g. to abort
 * the underlying request.
 */
export function withIdleTimeout(source: Readable, idleMs: number, onIdle: () => void): Readable {
  let timer: NodeJS.Timeout | undefined;
  const stop = () => clearTimeout(timer);
  const arm = () => {
    stop();
    timer = setTimeout(() => {
      onIdle();
      output.destroy(
        new Error(`Google Drive download stalled: no data for ${Math.round(idleMs / 1000)}s`),
      );
    }, idleMs);
  };
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      arm();
      callback(null, chunk);
    },
    // The source is done; what is left is buffered here and only waits for the consumer.
    flush(callback) {
      stop();
      callback();
    },
  });
  pipeline(source, output, stop);
  arm();
  return output;
}
