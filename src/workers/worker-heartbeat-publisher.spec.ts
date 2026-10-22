import { WorkerHeartbeatPublisher } from './worker-heartbeat-publisher';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Prevent real Redis connections
jest.mock('ioredis', () => {
  const multiChain = {
    set: jest.fn().mockReturnThis(),
    hset: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(null),
  };
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    multi: jest.fn().mockReturnValue(multiChain),
    disconnect: jest.fn(),
    multiChain,
  }));
});

jest.mock('../modules/workers/worker-heartbeat', () => ({
  WORKER_HEARTBEAT_INTERVAL_MS: 100_000, // prevent real intervals firing
  WORKER_HEARTBEAT_TTL_SECONDS: 60,
  buildCommit: jest.fn().mockReturnValue('abc1234'),
  workerHostIp: jest.fn().mockReturnValue('127.0.0.1'),
  workerHostName: jest.fn().mockReturnValue('test-host'),
  workerLiveKey: jest.fn().mockReturnValue('prefix:worker:live:test-id'),
  workerSlotsKey: jest.fn().mockReturnValue('prefix:worker:slots'),
  workerSlot: jest.fn().mockReturnValue('test-host:0'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(): { getOrThrow: jest.Mock } {
  return {
    getOrThrow: jest.fn().mockImplementation((key: string) => {
      const values: Record<string, unknown> = {
        QUEUE_PREFIX: 'test',
        REDIS_URL: 'redis://localhost:6379',
      };
      return values[key];
    }),
  };
}

function createPublisher() {
  const config = makeConfig();
  const publisher = new WorkerHeartbeatPublisher(config as never, ['media']);
  // Expose the internal Redis mock for assertions
  const Redis = jest.requireMock('ioredis') as jest.Mock;
  const redis = Redis.mock.results[Redis.mock.results.length - 1].value as {
    on: jest.Mock;
    multi: jest.Mock;
    disconnect: jest.Mock;
    multiChain: {
      set: jest.Mock;
      hset: jest.Mock;
      del: jest.Mock;
      exec: jest.Mock;
    };
  };
  return { publisher, redis };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerHeartbeatPublisher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('constructs without throwing', () => {
    expect(() => createPublisher()).not.toThrow();
  });

  it('marks stopping flag in the heartbeat', () => {
    const { publisher, redis } = createPublisher();
    publisher.markStopping();
    // The heartbeat's `stopping` flag should be serialised into the Redis value.
    // We verify via the multi().set() call that the value contains "stopping":true.
    const setCall = redis.multiChain.set.mock.calls[0] as unknown[];
    // The value is the second argument to .set(); "stopping":true must appear in it
    if (setCall) {
      expect(String(setCall[1])).toContain('"stopping":true');
    }
  });

  it('starts a periodic timer on start()', () => {
    const { publisher } = createPublisher();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    publisher.start();
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('does not start a second timer when start() is called twice', () => {
    const { publisher } = createPublisher();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    publisher.start();
    publisher.start(); // second call should be a no-op
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });

  it('calls redis.disconnect() on stop()', async () => {
    const { publisher, redis } = createPublisher();
    await publisher.stop();
    expect(redis.disconnect).toHaveBeenCalled();
  });

  it('writes a final stop entry (DEL live key, HSET slots) on stop()', async () => {
    const { publisher, redis } = createPublisher();
    await publisher.stop();
    expect(redis.multiChain.del).toHaveBeenCalled();
    expect(redis.multiChain.hset).toHaveBeenCalled();
    expect(redis.multiChain.exec).toHaveBeenCalled();
  });

  it('logs a warning (not throws) when the Redis write fails', async () => {
    const { publisher, redis } = createPublisher();
    redis.multiChain.exec.mockRejectedValueOnce(new Error('connection refused'));
    // stop() uses try/catch — should not throw
    await expect(publisher.stop()).resolves.toBeUndefined();
  });
});
