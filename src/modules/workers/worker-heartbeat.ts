import type { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';

/**
 * Every worker process (on every host) reports itself in Redis so the api can list them:
 * - a live key per process, refreshed every WORKER_HEARTBEAT_INTERVAL_MS, that expires
 *   WORKER_HEARTBEAT_TTL_SECONDS after the last refresh (crash, OOM kill, host or network down);
 * - the last heartbeat of every slot (host + IP + roles) in one hash, so a slot without a live
 *   process is still listed: as stopped after a clean stop (deploy, `docker compose stop`, a
 *   Windows reboot that Docker Desktop does not come back from), else as offline.
 */
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_HEARTBEAT_TTL_SECONDS = 45;
/** Stopped and offline slots are dropped after this long: the host is most likely gone for good. */
export const WORKER_OFFLINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkerHeartbeat = {
  /** Random per process: several processes can share a slot (`docker compose --scale`). */
  id: string;
  host: string;
  /** The machine's IP (WORKER_HOST_IP from the deploy scripts), null when unknown. */
  ip: string | null;
  roles: string[];
  /** Full commit hash the image was built from, null when unknown (local runs, manual builds). */
  commit: string | null;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  /** True once the process got SIGTERM and is finishing its running jobs. */
  stopping: boolean;
  /** When the process stopped cleanly, its jobs done; null while it runs. */
  stoppedAt: string | null;
  memoryRssBytes: number;
};

export function workerLiveKey(queuePrefix: string, id: string): string {
  return `${queuePrefix}:workers:live:${id}`;
}

export function workerLiveKeyPattern(queuePrefix: string): string {
  return `${queuePrefix}:workers:live:*`;
}

export function workerSlotsKey(queuePrefix: string): string {
  return `${queuePrefix}:workers:slots`;
}

/** With the IP, two machines left with the same hostname (`ubuntu`...) keep separate slots. */
export function workerSlot(heartbeat: Pick<WorkerHeartbeat, 'host' | 'ip' | 'roles'>): string {
  return `${heartbeat.host}|${heartbeat.ip ?? ''}|${heartbeat.roles.join(',')}`;
}

/** Commit of the running image (Dockerfile GIT_COMMIT build arg), null when unknown. */
export function buildCommit(config: ConfigService): string | null {
  return config.get<string>('GIT_COMMIT')?.trim() || null;
}

/**
 * Name of the machine running the process. Inside a container os.hostname() is the container
 * id, so the deploy scripts pass the host's own name as WORKER_HOSTNAME.
 */
export function workerHostName(config: ConfigService): string {
  return config.get<string>('WORKER_HOSTNAME')?.trim() || hostname();
}

/**
 * IP of the machine running the process, null when unknown. A container only sees its own
 * Docker network address, so the deploy scripts pass the host's as WORKER_HOST_IP.
 */
export function workerHostIp(config: ConfigService): string | null {
  return config.get<string>('WORKER_HOST_IP')?.trim() || null;
}

export function parseWorkerHeartbeat(value: string | null): WorkerHeartbeat | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<WorkerHeartbeat>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.host !== 'string' ||
      !Array.isArray(parsed.roles) ||
      typeof parsed.lastSeenAt !== 'string'
    ) {
      return null;
    }
    return {
      id: parsed.id,
      host: parsed.host,
      ip: typeof parsed.ip === 'string' && parsed.ip ? parsed.ip : null,
      roles: parsed.roles.map(String),
      commit: typeof parsed.commit === 'string' && parsed.commit ? parsed.commit : null,
      pid: Number(parsed.pid) || 0,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : parsed.lastSeenAt,
      lastSeenAt: parsed.lastSeenAt,
      stopping: parsed.stopping === true,
      stoppedAt: typeof parsed.stoppedAt === 'string' ? parsed.stoppedAt : null,
      memoryRssBytes: Number(parsed.memoryRssBytes) || 0,
    };
  } catch {
    return null;
  }
}
