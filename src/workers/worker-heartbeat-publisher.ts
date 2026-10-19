import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  buildCommit,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
  workerHostIp,
  workerHostName,
  workerLiveKey,
  workerSlot,
  workerSlotsKey,
  type WorkerHeartbeat,
} from '../modules/workers/worker-heartbeat';

/**
 * Reports this worker process in Redis for the api's worker list (see worker-heartbeat.ts).
 * Not a Nest provider on purpose: it has to keep reporting while app.close() lets the running
 * jobs finish, and only stop once they are done.
 */
export class WorkerHeartbeatPublisher {
  private readonly logger = new Logger('WorkerHeartbeat');
  private readonly connection: Redis;
  private readonly heartbeat: WorkerHeartbeat;
  private readonly liveKey: string;
  private readonly slotsKey: string;
  private timer?: NodeJS.Timeout;
  private writing?: Promise<void>;
  private failing = false;

  constructor(config: ConfigService, roles: string[]) {
    const queuePrefix = config.getOrThrow<string>('QUEUE_PREFIX');
    const now = new Date().toISOString();
    this.heartbeat = {
      id: randomUUID(),
      host: workerHostName(config),
      ip: workerHostIp(config),
      roles,
      commit: buildCommit(config),
      pid: process.pid,
      startedAt: now,
      lastSeenAt: now,
      stopping: false,
      stoppedAt: null,
      memoryRssBytes: 0,
    };
    this.liveKey = workerLiveKey(queuePrefix, this.heartbeat.id);
    this.slotsKey = workerSlotsKey(queuePrefix);
    // A heartbeat that cannot be written is retried on the next tick rather than queued.
    this.connection = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 1,
    });
    // Failed writes are logged below; this only keeps ioredis from printing every reconnect.
    this.connection.on('error', () => undefined);
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.beat();
    this.timer = setInterval(() => void this.beat(), WORKER_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  /** On SIGTERM: keeps reporting, flagged as stopping, while the running jobs finish. */
  markStopping(): void {
    this.heartbeat.stopping = true;
    void this.beat();
  }

  /** Once the jobs are done: removes this process, and leaves its slot listed as stopped. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.writing;
    const now = new Date().toISOString();
    try {
      await this.connection
        .multi()
        .del(this.liveKey)
        .hset(
          this.slotsKey,
          workerSlot(this.heartbeat),
          this.serialize({ stopping: false, stoppedAt: now, lastSeenAt: now }),
        )
        .exec();
    } catch (error) {
      this.logger.warn(`Could not record the worker stop: ${(error as Error).message}`);
    } finally {
      this.connection.disconnect();
    }
  }

  private beat(): Promise<void> {
    this.writing ??= this.write().finally(() => {
      this.writing = undefined;
    });
    return this.writing;
  }

  private serialize(overrides: Partial<WorkerHeartbeat> = {}): string {
    return JSON.stringify({
      ...this.heartbeat,
      lastSeenAt: new Date().toISOString(),
      memoryRssBytes: process.memoryUsage.rss(),
      ...overrides,
    } satisfies WorkerHeartbeat);
  }

  private async write(): Promise<void> {
    const value = this.serialize();
    try {
      await this.connection
        .multi()
        .set(this.liveKey, value, 'EX', WORKER_HEARTBEAT_TTL_SECONDS)
        .hset(this.slotsKey, workerSlot(this.heartbeat), value)
        .exec();
      if (this.failing) {
        this.failing = false;
        this.logger.log('Worker heartbeat restored');
      }
    } catch (error) {
      // Logged once per outage: Redis being down already shows in every queue's own errors.
      if (!this.failing) {
        this.failing = true;
        this.logger.warn(`Could not write the worker heartbeat: ${(error as Error).message}`);
      }
    }
  }
}
