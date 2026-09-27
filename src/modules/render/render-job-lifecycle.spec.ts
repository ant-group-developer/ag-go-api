import type { EntityManager } from 'typeorm';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';
import { cancelSupersededRenderJobs, refreshRenderBatch } from './render-job-lifecycle';

type JobRow = { id: string; status: string };

/**
 * An EntityManager stand-in recording the order of the lock, the count and the write, with
 * `jobsOf` giving each batch's jobs as the count reads them.
 */
function createManager(jobsOf: (batchId: string) => JobRow[], cancelledRows: unknown[] = []) {
  const steps: string[] = [];
  const cancelQuery = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: cancelledRows }),
  };
  let lockedBatch = '';
  const lockQuery = {
    select: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn(function (this: unknown, _sql: string, { batchId }: { batchId: string }) {
      lockedBatch = batchId;
      return this;
    }),
    getOne: jest.fn(async () => {
      steps.push(`lock ${lockedBatch}`);
      return { id: lockedBatch };
    }),
  };
  let countedBatch = '';
  const countQuery = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn(function (this: unknown, _sql: string, { batchId }: { batchId: string }) {
      countedBatch = batchId;
      return this;
    }),
    // What the aggregate returns for the jobs `jobsOf` gives.
    getRawOne: jest.fn(async () => {
      steps.push(`count ${countedBatch}`);
      const statuses = jobsOf(countedBatch).map((row) => row.status);
      const count = (status: string) => statuses.filter((value) => value === status).length;
      return {
        total: statuses.length,
        completed: count('completed'),
        failed: count('failed'),
        cancelled: count('cancelled'),
      };
    }),
  };
  const manager = {
    transaction: jest.fn(function (this: unknown, work: (m: unknown) => Promise<unknown>) {
      return work(this);
    }),
    // The cancel query is the only one built without an entity.
    createQueryBuilder: jest.fn((entity?: unknown) =>
      entity === RenderBatchEntity ? lockQuery : entity ? countQuery : cancelQuery,
    ),
    update: jest.fn(async (_entity: unknown, batchId: string) => {
      steps.push(`write ${batchId}`);
    }),
  };
  return { manager: manager as unknown as EntityManager, mock: manager, lockQuery, steps };
}

const job = (status: string, index = 0): JobRow => ({ id: `job-${index}`, status });

describe('refreshRenderBatch', () => {
  it('locks the batch row before counting its jobs, in a transaction', async () => {
    const { manager, mock, lockQuery, steps } = createManager(() => [
      job('completed', 1),
      job('completed', 2),
      job('failed', 3),
    ]);

    await refreshRenderBatch(manager, 'batch-1');

    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(lockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
    // Counted after the lock, so a refresh waiting on another one sees its jobs too.
    expect(steps).toEqual(['lock batch-1', 'count batch-1', 'write batch-1']);
    expect(mock.update).toHaveBeenCalledWith(RenderBatchEntity, 'batch-1', {
      status: 'partial',
      totalJobs: 3,
      completedJobs: 2,
      failedJobs: 1,
      progressPercent: 100,
    });
  });

  it('keeps a batch processing while one of its jobs still runs', async () => {
    const { manager, mock } = createManager(() => [job('completed', 1), job('processing', 2)]);

    await refreshRenderBatch(manager, 'batch-1');

    expect(mock.update).toHaveBeenCalledWith(
      RenderBatchEntity,
      'batch-1',
      expect.objectContaining({ status: 'processing', completedJobs: 1, progressPercent: 50 }),
    );
  });

  it('cancels a batch whose jobs were all deleted with their project', async () => {
    const { manager, mock } = createManager(() => []);

    await refreshRenderBatch(manager, 'batch-1');

    expect(mock.update).toHaveBeenCalledWith(RenderBatchEntity, 'batch-1', {
      status: 'cancelled',
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      progressPercent: 100,
    });
  });

  it('does nothing without a batch', async () => {
    const { manager, mock } = createManager(() => []);

    await refreshRenderBatch(manager, null);

    expect(mock.transaction).not.toHaveBeenCalled();
  });
});

describe('cancelSupersededRenderJobs', () => {
  it('refreshes the affected batches in a fixed order, so two cancels cannot deadlock', async () => {
    const { manager, steps } = createManager(
      () => [job('cancelled')],
      [
        { id: 'job-1', render_batch_id: 'batch-b' },
        { id: 'job-2', render_batch_id: null },
        { id: 'job-3', render_batch_id: 'batch-a' },
        { id: 'job-4', render_batch_id: 'batch-b' },
      ],
    );

    await expect(cancelSupersededRenderJobs(manager, ['asset-1'], [])).resolves.toEqual([
      'job-1',
      'job-2',
      'job-3',
      'job-4',
    ]);

    expect(steps.filter((step) => step.startsWith('lock'))).toEqual(['lock batch-a', 'lock batch-b']);
  });
});
