import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  buildCommit,
  parseWorkerHeartbeat,
  WORKER_OFFLINE_RETENTION_MS,
  workerLiveKeyPattern,
  workerSlot,
  workerSlotsKey,
  type WorkerHeartbeat,
} from './worker-heartbeat';

/**
 * running: reporting. stopping: got SIGTERM, finishing its running jobs (a deploy).
 * stopped: stopped cleanly and nothing took its slot again (`docker compose stop`, a reboot
 * Docker did not come back from). offline: stopped reporting without a clean stop (crash,
 * host or network down).
 */
export type WorkerStatus = 'running' | 'stopping' | 'stopped' | 'offline';

export type WorkerInstance = WorkerHeartbeat & {
  status: WorkerStatus;
  /** Runs another commit than the api (both known). */
  outdated: boolean;
};

export type WorkersOverview = {
  /** Commit of the api answering, the one workers are compared with; null when unknown. */
  apiCommit: string | null;
  checkedAt: string;
  workers: WorkerInstance[];
};

/**
 * Lists the live processes plus the slots without one (stopped or offline), and the slots to
 * forget: unreadable, or without a live process for longer than WORKER_OFFLINE_RETENTION_MS.
 */
export function summarizeWorkers(
  live: WorkerHeartbeat[],
  slots: Record<string, string>,
  apiCommit: string | null,
  now: Date,
): { workers: WorkerInstance[]; expiredSlots: string[] } {
  const outdated = (heartbeat: WorkerHeartbeat) =>
    apiCommit !== null && heartbeat.commit !== null && heartbeat.commit !== apiCommit;
  const workers: WorkerInstance[] = live.map((heartbeat) => ({
    ...heartbeat,
    status: heartbeat.stopping ? 'stopping' : 'running',
    outdated: outdated(heartbeat),
  }));
  const liveSlots = new Set(live.map(workerSlot));
  const expiredSlots: string[] = [];
  for (const [slot, value] of Object.entries(slots)) {
    if (liveSlots.has(slot)) {
      continue;
    }
    const heartbeat = parseWorkerHeartbeat(value);
    const lastSeen = heartbeat ? Date.parse(heartbeat.lastSeenAt) : NaN;
    if (!heartbeat || !(now.getTime() - lastSeen < WORKER_OFFLINE_RETENTION_MS)) {
      expiredSlots.push(slot);
      continue;
    }
    workers.push({
      ...heartbeat,
      stopping: false,
      status: heartbeat.stoppedAt ? 'stopped' : 'offline',
      outdated: outdated(heartbeat),
    });
  }
  workers.sort(
    (a, b) =>
      a.host.localeCompare(b.host) ||
      (a.ip ?? '').localeCompare(b.ip ?? '') ||
      a.roles.join(',').localeCompare(b.roles.join(',')) ||
      a.startedAt.localeCompare(b.startedAt),
  );
  return { workers, expiredSlots };
}

@Injectable()
export class WorkersService implements OnModuleDestroy {
  private connection?: Redis;

  constructor(private readonly config: ConfigService) {}

  async list(): Promise<WorkersOverview> {
    const queuePrefix = this.config.getOrThrow<string>('QUEUE_PREFIX');
    const redis = this.getConnection();
    const liveKeys = await this.scanKeys(redis, workerLiveKeyPattern(queuePrefix));
    const live = (liveKeys.length > 0 ? await redis.mget(liveKeys) : [])
      .map(parseWorkerHeartbeat)
      .filter((heartbeat): heartbeat is WorkerHeartbeat => heartbeat !== null);
    const slots = await redis.hgetall(workerSlotsKey(queuePrefix));
    const now = new Date();
    const { workers, expiredSlots } = summarizeWorkers(live, slots, buildCommit(this.config), now);
    if (expiredSlots.length > 0) {
      await redis.hdel(workerSlotsKey(queuePrefix), ...expiredSlots);
    }
    return { apiCommit: buildCommit(this.config), checkedAt: now.toISOString(), workers };
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.quit();
  }

  private async scanKeys(redis: Redis, pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  private getConnection(): Redis {
    this.connection ??= new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 1,
    });
    return this.connection;
  }
}
