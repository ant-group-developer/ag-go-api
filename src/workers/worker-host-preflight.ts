/**
 * Run by deploy-worker-host.sh inside a freshly built image, before the running workers of an
 * extra host are replaced. It checks the host's .env against what the main host uses, with
 * the app's own code: Postgres and Redis are reachable, the clock is close to the database's,
 * the migrations match, QUEUE_PREFIX, R2 and the Google token key are the main host's.
 * Read-only. Exits non-zero with the reason on the first failed check.
 *
 * A wrong value there does real damage rather than just failing: a wrong Google token key
 * marks users' Drive connections as needing a reconnect, wrong R2 settings fail every file
 * that host imports, and another QUEUE_PREFIX sends its render jobs where no one else looks.
 */
import type { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MigrationExecutor } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { AssetEntity } from '../database/entities/asset.entity';
import { GoogleDriveConnectionEntity } from '../database/entities/google-drive-connection.entity';
import { MEDIA_PROCESSING_QUEUE } from '../infra/queue/queue.constants';
import { R2StorageAdapter } from '../modules/assets/storage/r2-storage.adapter';
import { GoogleDriveService } from '../modules/google-drive/google-drive.service';
import {
  assertClockSkew,
  assertMigrationsMatch,
  clockSkewSeconds,
  connectionHeadroomWarning,
} from './worker-host-preflight-checks';

const TIMEOUT_MS = 10_000;
/** deploy-worker-host.sh starts worker-media and worker-io. */
const WORKERS_PER_HOST = 2;

/** The pool size the workers of this host get (the data source used here has the same one). */
function validatedPoolMax(): number {
  return (AppDataSource.options as { poolSize?: number }).poolSize ?? 10;
}

/** Fails a check that hangs (e.g. an unreachable R2 endpoint) instead of stalling the deploy. */
async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not answer in ${TIMEOUT_MS} ms`)),
      TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** ConfigService stand-in over the container env, enough for the classes used here. */
function envConfig(): ConfigService {
  return {
    get: (key: string) => process.env[key],
    getOrThrow: (key: string) => {
      const value = process.env[key];
      if (value === undefined || value === '') {
        throw new Error(`${key} is not set`);
      }
      return value;
    },
  } as unknown as ConfigService;
}

async function checkDatabase(): Promise<string[]> {
  const notes: string[] = [];
  const [{ now }] = (await AppDataSource.query('SELECT NOW() AS now')) as Array<{ now: Date }>;
  const warning = assertClockSkew(clockSkewSeconds(new Date(now)));
  if (warning) {
    notes.push(`warning: ${warning}`);
  }
  // Client connections only (background processes have their own slots); reserved_connections
  // exists from Postgres 16 on.
  const [connections] = (await AppDataSource.query(
    `SELECT current_setting('max_connections')::int AS max,
       current_setting('superuser_reserved_connections')::int
         + COALESCE(current_setting('reserved_connections', true), '0')::int AS reserved,
       (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')::int AS open`,
  )) as Array<{ max: number; reserved: number; open: number }>;
  const headroom = connectionHeadroomWarning({
    ...connections,
    // worker-media and worker-io, each with a pool of DATABASE_POOL_MAX (docker-compose.yml).
    adding: WORKERS_PER_HOST * validatedPoolMax(),
  });
  if (headroom) {
    notes.push(`warning: ${headroom}`);
  }
  const executed = await new MigrationExecutor(AppDataSource).getExecutedMigrations();
  assertMigrationsMatch(
    executed,
    AppDataSource.migrations.map((migration) => migration.name ?? migration.constructor.name),
  );
  notes.push('Postgres reachable, clock and migrations match');
  return notes;
}

async function checkStorage(): Promise<string> {
  const asset = await AppDataSource.getRepository(AssetEntity).findOne({
    select: { id: true, originalStorageKey: true },
    where: { processingStatus: 'ready' },
    order: { createdAt: 'DESC' },
  });
  if (!asset) {
    return 'R2 not checked: no ready asset yet';
  }
  const head = await withTimeout(
    new R2StorageAdapter(envConfig()).headObject(asset.originalStorageKey),
    'R2',
  );
  if (!head) {
    throw new Error(
      `R2 has no ${asset.originalStorageKey}; R2_BUCKET and R2_ENDPOINT must be the main host's`,
    );
  }
  return 'R2 reachable, bucket matches';
}

async function checkGoogleDrive(): Promise<string> {
  // Any stored connection will do, revoked or not: its token was encrypted with the main
  // host's key all the same.
  const [connection] = await AppDataSource.getRepository(GoogleDriveConnectionEntity).find({
    order: { updatedAt: 'DESC' },
    take: 1,
  });
  if (!connection) {
    return 'Google Drive not checked: no connection stored yet';
  }
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_TOKEN_ENCRYPTION_KEY']) {
    if (!process.env[key]?.trim()) {
      throw new Error(`${key} is empty; Drive imports on this host would fail`);
    }
  }
  // Only the token decryption is used, which needs nothing but the config.
  const drive = new (
    GoogleDriveService as unknown as new (config: ConfigService) => {
      decrypt(value: string): string;
    }
  )(envConfig());
  try {
    drive.decrypt(connection.encryptedRefreshToken);
  } catch (error) {
    throw new Error(
      `GOOGLE_TOKEN_ENCRYPTION_KEY cannot decrypt the stored Drive tokens (${
        error instanceof Error ? error.message : String(error)
      }); copy the main host's`,
    );
  }
  return 'Google Drive token key matches';
}

async function checkRedis(): Promise<string> {
  const redis = new Redis(envConfig().getOrThrow<string>('REDIS_URL'), {
    lazyConnect: true,
    connectTimeout: TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  let lastError: Error | undefined;
  redis.on('error', (error: Error) => {
    lastError = error;
  });
  try {
    try {
      await redis.connect();
      await redis.ping();
    } catch (error) {
      throw new Error(`Redis: ${(lastError ?? (error as Error)).message}`);
    }
    // The main host's queues exist under its prefix; none under ours means another prefix.
    const pattern = `${envConfig().getOrThrow<string>('QUEUE_PREFIX')}:${MEDIA_PROCESSING_QUEUE}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      if (keys.length > 0) {
        return 'Redis reachable, QUEUE_PREFIX matches';
      }
      cursor = next;
    } while (cursor !== '0');
    throw new Error(
      `Redis has no ${pattern} keys; QUEUE_PREFIX must be the main host's (on a brand-new system, let the main host render one upload first)`,
    );
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  AppDataSource.setOptions({ connectTimeoutMS: TIMEOUT_MS });
  await AppDataSource.initialize();
  try {
    for (const note of await checkDatabase()) {
      console.log(note);
    }
    console.log(await checkStorage());
    console.log(await checkGoogleDrive());
  } finally {
    await AppDataSource.destroy();
  }
  console.log(await checkRedis());
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(`Preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
