import { workerSlot, type WorkerHeartbeat } from './worker-heartbeat';
import { summarizeWorkers } from './workers.service';

const NOW = new Date('2026-10-16T10:00:00.000Z');
const API_COMMIT = 'a'.repeat(40);

function heartbeat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    id: 'p1',
    host: 'vps-1',
    ip: '10.0.0.1',
    roles: ['media'],
    commit: API_COMMIT,
    pid: 1,
    startedAt: '2026-10-16T09:00:00.000Z',
    lastSeenAt: '2026-10-16T09:59:50.000Z',
    stopping: false,
    stoppedAt: null,
    memoryRssBytes: 1024,
    ...overrides,
  };
}

function slots(...heartbeats: WorkerHeartbeat[]): Record<string, string> {
  return Object.fromEntries(heartbeats.map((item) => [workerSlot(item), JSON.stringify(item)]));
}

describe('summarizeWorkers', () => {
  it('lists live processes as running or stopping, and flags another commit than the api', () => {
    const current = heartbeat();
    const draining = heartbeat({
      id: 'p2',
      roles: ['download', 'import', 'outbox'],
      stopping: true,
    });
    const old = heartbeat({ id: 'p3', host: 'vps-2', commit: 'b'.repeat(40) });

    const { workers } = summarizeWorkers(
      [old, draining, current],
      slots(current, draining, old),
      API_COMMIT,
      NOW,
    );

    expect(workers.map(({ id, status, outdated }) => ({ id, status, outdated }))).toEqual([
      { id: 'p2', status: 'stopping', outdated: false },
      { id: 'p1', status: 'running', outdated: false },
      { id: 'p3', status: 'running', outdated: true },
    ]);
  });

  it('lists a slot without a live process as offline, with its last heartbeat', () => {
    const gone = heartbeat({ host: 'vps-2', lastSeenAt: '2026-10-15T08:00:00.000Z' });

    const { workers, expiredSlots } = summarizeWorkers([], slots(gone), API_COMMIT, NOW);

    expect(workers).toEqual([{ ...gone, status: 'offline', outdated: false }]);
    expect(expiredSlots).toEqual([]);
  });

  it('lists a slot that stopped cleanly as stopped, and forgets it after a week', () => {
    const stopped = heartbeat({
      lastSeenAt: '2026-10-16T08:00:00.000Z',
      stoppedAt: '2026-10-16T08:00:00.000Z',
    });
    const longStopped = heartbeat({
      host: 'vps-2',
      lastSeenAt: '2026-10-01T00:00:00.000Z',
      stoppedAt: '2026-10-01T00:00:00.000Z',
    });

    const { workers, expiredSlots } = summarizeWorkers(
      [],
      slots(stopped, longStopped),
      API_COMMIT,
      NOW,
    );

    expect(workers).toEqual([{ ...stopped, status: 'stopped', outdated: false }]);
    expect(expiredSlots).toEqual([workerSlot(longStopped)]);
  });

  it('hides a stopped slot once a process runs in it again (a deploy)', () => {
    const old = heartbeat({ id: 'old', stoppedAt: '2026-10-16T09:59:00.000Z' });
    const replacement = heartbeat({ id: 'new' });

    const { workers } = summarizeWorkers([replacement], slots(old), API_COMMIT, NOW);

    expect(workers.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'new', status: 'running' },
    ]);
  });

  it('tells apart machines left with the same hostname by their IP', () => {
    const alive = heartbeat({ host: 'ubuntu', ip: '10.0.0.1' });
    const gone = heartbeat({ id: 'p2', host: 'ubuntu', ip: '10.0.0.2' });

    const { workers } = summarizeWorkers([alive], slots(alive, gone), API_COMMIT, NOW);

    expect(workers.map(({ ip, status }) => ({ ip, status }))).toEqual([
      { ip: '10.0.0.1', status: 'running' },
      { ip: '10.0.0.2', status: 'offline' },
    ]);
  });

  it('forgets slots offline for over a week, and unreadable ones', () => {
    const longGone = heartbeat({ lastSeenAt: '2026-10-01T00:00:00.000Z' });

    const { workers, expiredSlots } = summarizeWorkers(
      [],
      { ...slots(longGone), 'vps-9|media': 'not json' },
      API_COMMIT,
      NOW,
    );

    expect(workers).toEqual([]);
    expect(expiredSlots).toEqual([workerSlot(longGone), 'vps-9|media']);
  });

  it('flags nothing as outdated when either commit is unknown', () => {
    const unknown = heartbeat({ commit: null });
    const other = heartbeat({ id: 'p2', host: 'vps-2', commit: 'b'.repeat(40) });

    expect(summarizeWorkers([unknown], {}, API_COMMIT, NOW).workers.map((w) => w.outdated)).toEqual(
      [false],
    );
    expect(summarizeWorkers([other], {}, null, NOW).workers.map((w) => w.outdated)).toEqual([
      false,
    ]);
  });
});
