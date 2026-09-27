import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import type { StorageAdapter } from '../../modules/assets/storage/storage-adapter';
import type { MediaQueueService } from './media-queue.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
}));
jest.mock('./media-queue.service', () => ({ MediaQueueService: class {} }));

function purgeEvent(attemptCount: number): OutboxEventEntity {
  return {
    id: '0194f7c2-7a11-7d2a-9b10-000000000001',
    eventType: 'project.storage.purge',
    aggregateType: 'project',
    aggregateId: '0194f7c2-7a11-7d2a-9b10-000000000002',
    payload: {
      prefix: 'projects/p1/',
      keepPrefixes: ['projects/p1/originals/shared.jpg', 'projects/p1/variants/shared/'],
    },
    status: 'failed',
    attemptCount,
    availableAt: new Date(),
    publishedAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function renderEvent(): OutboxEventEntity {
  return {
    ...purgeEvent(0),
    id: '0194f7c2-7a11-7d2a-9b10-000000000003',
    eventType: 'asset.processing.requested',
    aggregateType: 'asset',
    payload: { assetId: 'asset-1', renderJobId: 'job-1' },
  };
}

function setup(rows: OutboxEventEntity[], deletePrefix: jest.Mock, addProcessingJob = jest.fn()) {
  const orderBy = jest.fn();
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: orderBy.mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    setOnLocked: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  const manager = {
    createQueryBuilder: jest.fn(() => queryBuilder),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const update = jest.fn().mockResolvedValue(undefined);
  const dataSource = {
    transaction: jest.fn((work: (m: typeof manager) => unknown) => work(manager)),
    getRepository: jest.fn(() => ({ update })),
  } as unknown as DataSource;
  const service = new OutboxDispatcherService(
    dataSource,
    { addProcessingJob } as unknown as MediaQueueService,
    {} as ConfigService,
    { deletePrefix } as unknown as StorageAdapter,
  );
  return { service, update, orderBy, manager, dataSource, queryBuilder };
}

/** The retry delay SQL an update wrote, e.g. "NOW() + interval '40000 milliseconds'". */
function availableAtSql(update: jest.Mock): string {
  const [, values] = update.mock.calls.find(([, v]) => (v as { status?: string }).status === 'failed') as [
    string,
    { availableAt: () => string },
  ];
  return values.availableAt();
}

describe('OutboxDispatcherService', () => {
  afterEach(() => jest.useRealTimers());

  it('purges the project prefix but keeps objects of shared assets', async () => {
    const deletePrefix = jest.fn().mockResolvedValue(3);
    const { service, update, orderBy } = setup([purgeEvent(0)], deletePrefix);

    await expect(service.dispatchPending()).resolves.toBe(1);

    expect(orderBy).toHaveBeenCalledWith('event.availableAt', 'ASC');
    const [prefix, keep] = deletePrefix.mock.calls[0] as [string, (key: string) => boolean];
    expect(prefix).toBe('projects/p1/');
    expect(keep('projects/p1/originals/shared.jpg')).toBe(true);
    expect(keep('projects/p1/variants/shared/thumbnail.webp')).toBe(true);
    expect(keep('projects/p1/originals/other.jpg')).toBe(false);
    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'published' }),
    );
  });

  it('purges each folder of deleted assets stored outside a project prefix', async () => {
    const deletePrefix = jest.fn().mockResolvedValue(1);
    const event = {
      ...purgeEvent(0),
      eventType: 'asset.storage.purge',
      payload: { prefixes: ['projects/p-old/originals/a.jpg', 'projects/p-old/variants/a/'] },
    };
    const { service, update } = setup([event], deletePrefix);

    await expect(service.dispatchPending()).resolves.toBe(1);

    expect(deletePrefix.mock.calls).toEqual([
      ['projects/p-old/originals/a.jpg'],
      ['projects/p-old/variants/a/'],
    ]);
    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 'published' }),
    );
  });

  it('refuses an asset purge broader than one asset folder', async () => {
    const deletePrefix = jest.fn().mockResolvedValue(1);
    const event = {
      ...purgeEvent(0),
      eventType: 'asset.storage.purge',
      payload: { prefixes: ['projects/p-old/variants/a/', 'projects/p-live/'] },
    };
    const { service } = setup([event], deletePrefix);

    await expect(service.dispatchPending()).resolves.toBe(0);

    expect(deletePrefix).not.toHaveBeenCalled();
  });

  it('leases each claimed event on the database clock so no other poll publishes it again', async () => {
    const { service, manager } = setup([purgeEvent(0)], jest.fn().mockResolvedValue(0));

    await service.dispatchPending();

    // Claimed events stay pending while they are published, so the lease is what hides them
    // from the next poll of this or another worker host.
    const [, id, values] = manager.update.mock.calls[0] as [
      unknown,
      string,
      { availableAt: () => string },
    ];
    expect(id).toBe(purgeEvent(0).id);
    expect(values).toMatchObject({ attemptCount: 1, lastError: null });
    expect(values.availableAt()).toBe("NOW() + interval '5 minutes'");
  });

  it('backs off exponentially on the database clock when R2 denies access', async () => {
    const deletePrefix = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    const { service, update } = setup([purgeEvent(3)], deletePrefix);

    await service.dispatchPending();

    expect(update).toHaveBeenCalledWith(expect.any(String), {
      status: 'failed',
      availableAt: expect.any(Function),
      lastError: 'AccessDenied',
    });
    // Fourth attempt: 5 s * 2^3.
    expect(availableAtSql(update)).toBe("NOW() + interval '40000 milliseconds'");
  });

  it('caps the retry delay at an hour', async () => {
    const deletePrefix = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    const { service, update } = setup([purgeEvent(20)], deletePrefix);

    await service.dispatchPending();

    expect(availableAtSql(update)).toBe("NOW() + interval '3600000 milliseconds'");
  });

  it('publishes a render request without waiting for a slow purge claimed with it', async () => {
    const addProcessingJob = jest.fn().mockResolvedValue(undefined);
    // A purge of a large project that is still running.
    const deletePrefix = jest.fn(() => new Promise(() => undefined));
    const { service, update } = setup([purgeEvent(0), renderEvent()], deletePrefix, addProcessingJob);

    void service.dispatchPending();
    await new Promise((resolve) => setImmediate(resolve));

    expect(addProcessingJob).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: renderEvent().id, assetId: 'asset-1' }),
    );
    expect(update).toHaveBeenCalledWith(
      renderEvent().id,
      expect.objectContaining({ status: 'published' }),
    );
  });

  it('keeps claiming new render requests while a long purge is still publishing', async () => {
    const addProcessingJob = jest.fn().mockResolvedValue(undefined);
    // A purge of a large project that is still running.
    const deletePrefix = jest.fn(() => new Promise(() => undefined));
    const { service, dataSource, queryBuilder } = setup([], deletePrefix, addProcessingJob);
    queryBuilder.getMany
      .mockResolvedValueOnce([purgeEvent(0)])
      .mockResolvedValueOnce([renderEvent()]);
    const tick = () => (service as unknown as { tick: () => Promise<void> }).tick();

    // The first tick returns once it claimed the purge, without waiting for it.
    await tick();
    await tick();
    await new Promise((resolve) => setImmediate(resolve));

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(addProcessingJob).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: renderEvent().id }),
    );
  });

  it('runs one claim at a time and survives a failed poll', async () => {
    const { service, dataSource } = setup([], jest.fn());
    const tick = () => (service as unknown as { tick: () => Promise<void> }).tick();
    let failPoll!: (error: Error) => void;
    (dataSource.transaction as jest.Mock).mockImplementationOnce(
      () => new Promise((_, reject) => (failPoll = reject)),
    );

    const first = tick();
    await tick();
    // The second tick found the first poll still running and skipped.
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);

    failPoll(new Error('Connection terminated unexpectedly'));
    await expect(first).resolves.toBeUndefined();
    await tick();
    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
  });

  it('parks the event as dead after the last attempt', async () => {
    const deletePrefix = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    const { service, update } = setup([purgeEvent(29)], deletePrefix);

    await service.dispatchPending();

    expect(update).toHaveBeenCalledWith(expect.any(String), {
      status: 'dead',
      lastError: 'AccessDenied',
    });
  });
});
