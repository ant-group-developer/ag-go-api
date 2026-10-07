import { Readable } from 'node:stream';
import { cancellableBody, DownloadCancelledError } from './download-cancellation';
import { DownloadWorkerService } from './download-worker.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));

type JobRow = { id: string; status: string; completedItems: number };

/** A worker over in-memory repositories; the job is cancelled after `cancelAfterEntries` files. */
function setup(options: { files: number; cancelAfterEntries?: number }) {
  const job: JobRow = { id: 'job-1', status: 'queued', completedItems: 0 };
  const items = Array.from({ length: options.files }, (_, index) => ({
    id: `item-${index}`,
    downloadJobId: job.id,
    projectMediaId: `media-${index}`,
    assetId: `asset-${index}`,
    status: 'queued',
  }));
  const readKeys: string[] = [];
  const jobRepository = {
    findOne: jest.fn(async () => ({ ...job, externalUserId: 'user-1', projectId: null })),
    update: jest.fn(async (criteria: string | { id: string; status?: string }, patch: object) => {
      const where = typeof criteria === 'string' ? { id: criteria } : criteria;
      if (where.status && where.status !== job.status) return { affected: 0 };
      Object.assign(job, patch);
      return { affected: 1 };
    }),
    increment: jest.fn(async () => {
      job.completedItems += 1;
      if (job.completedItems === options.cancelAfterEntries) {
        job.status = 'cancelled';
      }
    }),
  };
  const storage = {
    readObject: jest.fn((key: string) => {
      readKeys.push(key);
      return Readable.from([Buffer.from(`data of ${key}`)]);
    }),
    putObject: jest.fn(async (_key: string, body: Readable) => {
      let size = 0;
      for await (const chunk of body) size += (chunk as Buffer).length;
      return { sizeBytes: size };
    }),
  };
  const service = new DownloadWorkerService(
    { getOrThrow: () => 'bucket' } as never,
    { query: jest.fn(async () => []) } as never,
    jobRepository as never,
    { find: jest.fn(async () => items), update: jest.fn() } as never,
    {
      findOne: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        originalStorageKey: `key-${where.id}`,
        originalFilename: `${where.id}.mp4`,
      })),
    } as never,
    {} as never,
    {} as never,
    storage as never,
  );
  const run = () =>
    (service as unknown as { process(job: object): Promise<void> }).process({
      data: { jobId: job.id, userId: 'user-1' },
    });
  return { job, run, readKeys, storage };
}

describe('DownloadWorkerService — cancellation', () => {
  it('packs every file of a job nobody cancels', async () => {
    const { job, run, readKeys } = setup({ files: 3 });
    await run();
    expect(job.status).toBe('completed');
    expect(readKeys).toHaveLength(3);
  });

  it('stops reading files once the job is cancelled and keeps it cancelled', async () => {
    const { job, run, readKeys } = setup({ files: 5, cancelAfterEntries: 2 });
    await expect(run()).resolves.toBeUndefined();
    expect(job.status).toBe('cancelled');
    expect(readKeys).toEqual(['key-asset-0', 'key-asset-1']);
  });
});

describe('cancellableBody', () => {
  async function drain(body: AsyncIterable<unknown>) {
    const chunks: unknown[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return chunks;
  }

  it('checks at most once per interval and passes chunks through', async () => {
    let clock = 0;
    const isCancelled = jest.fn(async () => false);
    const source = (async function* () {
      for (let i = 0; i < 5; i++) {
        clock += 1_000;
        yield Buffer.from([i]);
      }
    })();
    const chunks = await drain(cancellableBody(source, 'job', isCancelled, 2_000, () => clock));
    expect(chunks).toHaveLength(5);
    expect(isCancelled).toHaveBeenCalledTimes(2);
  });

  it('throws and stops the source when the job is cancelled mid-file', async () => {
    let clock = 0;
    let read = 0;
    const source = (async function* () {
      for (let i = 0; i < 100; i++) {
        clock += 1_000;
        read += 1;
        yield Buffer.from([i]);
      }
    })();
    await expect(
      drain(
        cancellableBody(
          source,
          'job',
          async () => read >= 3,
          1_000,
          () => clock,
        ),
      ),
    ).rejects.toBeInstanceOf(DownloadCancelledError);
    expect(read).toBeLessThan(10);
  });
});
