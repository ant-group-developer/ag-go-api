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

function setup(rows: OutboxEventEntity[], deletePrefix: jest.Mock) {
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
    {} as MediaQueueService,
    {} as ConfigService,
    { deletePrefix } as unknown as StorageAdapter,
  );
  return { service, update, orderBy };
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

  it('backs off exponentially when R2 denies access', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-25T00:00:00Z') });
    const deletePrefix = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    const { service, update } = setup([purgeEvent(3)], deletePrefix);

    await service.dispatchPending();

    // Fourth attempt: 5 s * 2^3.
    expect(update).toHaveBeenCalledWith(expect.any(String), {
      status: 'failed',
      availableAt: new Date(Date.now() + 40_000),
      lastError: 'AccessDenied',
    });
  });

  it('caps the retry delay at an hour', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-25T00:00:00Z') });
    const deletePrefix = jest.fn().mockRejectedValue(new Error('AccessDenied'));
    const { service, update } = setup([purgeEvent(20)], deletePrefix);

    await service.dispatchPending();

    expect(update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ availableAt: new Date(Date.now() + 60 * 60 * 1000) }),
    );
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
