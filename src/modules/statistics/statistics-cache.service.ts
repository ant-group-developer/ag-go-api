import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../../common/auth-context.service';

/** How long a statistics response is reused: reloads and periodic refreshes hit the cache. */
export const STATISTICS_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 500;

type Entry = { expiresAt: number; value: Promise<unknown> };

/**
 * Short-lived, per-instance cache of the heavy statistics responses, keyed by caller and query.
 * Concurrent identical requests share one computation. Failures are not cached. Numbers can lag
 * by up to the TTL, which is fine for a dashboard; the live widgets (operations, activity) do
 * not use it.
 */
@Injectable()
export class StatisticsCacheService {
  private readonly entries = new Map<string, Entry>();

  wrap<T>(
    endpoint: string,
    context: Pick<AuthContext, 'userId' | 'userType'>,
    query: object,
    load: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([endpoint, context.userId, context.userType, query]);
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as Promise<T>;
    }

    const value = load();
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: now + STATISTICS_CACHE_TTL_MS, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) {
        this.entries.delete(key);
      }
    });
    this.prune(now);
    return value;
  }

  /** Drops expired entries, then the oldest ones beyond the size limit (Map keeps insertion order). */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) {
        break;
      }
      this.entries.delete(key);
    }
  }
}
