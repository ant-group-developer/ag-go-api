/** Thrown inside the ZIP stream once the user has cancelled the download job. */
export class DownloadCancelledError extends Error {
  constructor(readonly downloadId: string) {
    super(`Download job ${downloadId} was cancelled`);
    this.name = 'DownloadCancelledError';
  }
}

/** How often a long entry body re-checks whether the job was cancelled. */
export const CANCEL_CHECK_INTERVAL_MS = 2_000;

/**
 * Passes `body` through, asking `isCancelled` at most once per `intervalMs` while it streams,
 * and throws `DownloadCancelledError` when it says yes. Leaving the loop early destroys the
 * source stream, so a cancelled multi-GB video stops being read at once.
 */
export async function* cancellableBody(
  body: AsyncIterable<Buffer | Uint8Array>,
  downloadId: string,
  isCancelled: () => Promise<boolean>,
  intervalMs = CANCEL_CHECK_INTERVAL_MS,
  now: () => number = Date.now,
): AsyncGenerator<Buffer | Uint8Array> {
  let lastCheck = now();
  for await (const chunk of body) {
    if (now() - lastCheck >= intervalMs) {
      lastCheck = now();
      if (await isCancelled()) {
        throw new DownloadCancelledError(downloadId);
      }
    }
    yield chunk;
  }
}
