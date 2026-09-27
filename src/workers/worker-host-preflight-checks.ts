/**
 * Pure checks of the worker host preflight (worker-host-preflight.ts), kept apart from its
 * database, Redis and R2 wiring so they can be tested on their own.
 */

/** Past this, R2 rejects signed requests from the host and its renders and imports fail. */
export const MAX_CLOCK_SKEW_SECONDS = 300;
/** Past this, the host still works but its clock should be fixed (NTP). */
export const WARN_CLOCK_SKEW_SECONDS = 30;

/** Seconds the host clock is ahead (positive) or behind (negative) of the database's. */
export function clockSkewSeconds(databaseNow: Date, hostNow = Date.now()): number {
  return Math.round((hostNow - databaseNow.getTime()) / 1000);
}

/** Throws past MAX_CLOCK_SKEW_SECONDS; returns a warning past WARN_CLOCK_SKEW_SECONDS. */
export function assertClockSkew(skewSeconds: number): string | null {
  if (Math.abs(skewSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    throw new Error(`this host's clock is ${skewSeconds}s off the database's; enable NTP`);
  }
  if (Math.abs(skewSeconds) > WARN_CLOCK_SKEW_SECONDS) {
    return `this host's clock is ${skewSeconds}s off the database's; enable NTP`;
  }
  return null;
}

/**
 * Warns when the connections open now plus `adding` (this host's worker pools) would not fit
 * under Postgres' limit. Only a warning: on a redeploy, `open` still counts the pools of the
 * workers being replaced.
 */
export function connectionHeadroomWarning(connections: {
  max: number;
  reserved: number;
  open: number;
  adding: number;
}): string | null {
  const { max, reserved, open, adding } = connections;
  const available = max - reserved;
  if (open + adding <= available) {
    return null;
  }
  return `Postgres allows ${available} connections, ${open} are open and this host's workers add up to ${adding}; lower WORKER_DATABASE_POOL_MAX or raise max_connections`;
}

/** TypeORM reads a migration's timestamp from the last 13 digits of its name. */
export function migrationTimestamp(name: string): number {
  return Number(/(\d{13})$/.exec(name)?.[1] ?? 0);
}

/**
 * The image's migrations must match the database's exactly. Missing ones mean the main host
 * was not deployed yet; newer ones mean this checkout is behind the main host's, and old code
 * next to new (say, without render job claim tokens) can process jobs twice.
 */
export function assertMigrationsMatch(
  executed: Array<{ name: string; timestamp: number }>,
  imageMigrations: string[],
): void {
  const executedNames = new Set(executed.map((migration) => migration.name));
  const pending = imageMigrations.filter((name) => !executedNames.has(name));
  if (pending.length > 0) {
    throw new Error(
      `the database lacks migrations this image needs (${pending.join(', ')}); deploy the main host (deploy.sh) first`,
    );
  }
  // By timestamp, not name: migrations removed from the code long ago stay in the table.
  const imageLatest = Math.max(0, ...imageMigrations.map(migrationTimestamp));
  const newer = executed.filter((migration) => migration.timestamp > imageLatest);
  if (newer.length > 0) {
    throw new Error(
      `the database has migrations newer than this checkout (${newer
        .map((migration) => migration.name)
        .join(', ')}); git pull the commit the main host runs`,
    );
  }
}
