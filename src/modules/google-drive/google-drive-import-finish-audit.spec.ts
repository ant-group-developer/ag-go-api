import { GoogleDriveImportWorkerService } from './google-drive-import-worker.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

/**
 * The project audit log gets one entry when an import run ends, recorded by whichever job
 * refreshed the batch into its final status, and nothing while the batch is still running.
 */
describe('GoogleDriveImportWorkerService finish audit', () => {
  function createWorker(transition: Record<string, unknown> | undefined) {
    const query = jest
      .fn()
      // Item counts of the batch.
      .mockResolvedValueOnce([{ total: 43, completed: 40, failed: 3, active: 0 }])
      // Status before and after the update.
      .mockResolvedValueOnce(transition ? [transition] : []);
    const record = jest.fn().mockResolvedValue(undefined);
    const worker = new GoogleDriveImportWorkerService(
      {} as never,
      { query } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { record } as never,
    );
    const refresh = (batchId: string) =>
      (
        worker as unknown as { refreshBatchProgress: (id: string) => Promise<void> }
      ).refreshBatchProgress(batchId);
    return { refresh, record };
  }

  it('records the finish once, as the user who started the import', async () => {
    const { refresh, record } = createWorker({
      previousStatus: 'processing',
      status: 'partial',
      projectId: 'project-1',
      createdBy: 'user-1',
    });

    await refresh('batch-1');

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        actorUserId: 'user-1',
        action: 'import_partial',
        afterData: { batchId: 'batch-1', totalItems: 43, completedItems: 40, failedItems: 3 },
      }),
    );
  });

  it('records nothing when the batch was already finished', async () => {
    const { refresh, record } = createWorker({
      previousStatus: 'completed',
      status: 'completed',
      projectId: 'project-1',
      createdBy: 'user-1',
    });

    await refresh('batch-1');

    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing while files are still importing', async () => {
    const { refresh, record } = createWorker({
      previousStatus: 'processing',
      status: 'processing',
      projectId: 'project-1',
      createdBy: 'user-1',
    });

    await refresh('batch-1');

    expect(record).not.toHaveBeenCalled();
  });
});
