import { GoogleDriveImportWorkerService } from './google-drive-import-worker.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));
jest.mock('uuid', () => ({ v7: () => 'generated-uuid' }));

/**
 * With import workers on several hosts, "stale" must be judged on the database clock (the one
 * the heartbeats write with), or a host whose clock runs ahead re-queues live imports.
 */
describe('GoogleDriveImportWorkerService stale sweep', () => {
  it('judges stale items and batches on the database clock', async () => {
    // UPDATE ... RETURNING through DataSource.query yields [rows, affected].
    const query = jest.fn().mockResolvedValue([[], 0]);
    const batchQuery = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const service = new GoogleDriveImportWorkerService(
      {} as never,
      { query } as never,
      { createQueryBuilder: () => batchQuery } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (service as unknown as { recoverStaleImports: () => Promise<void> }).recoverStaleImports();

    // Cancelled, exhausted and re-queued items.
    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of query.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).toContain('updated_at < now() - $1::interval');
      expect(params[0]).toBe('120000 milliseconds');
      // A timestamp computed on this host would compare its clock with the database's.
      expect(params.some((value) => value instanceof Date)).toBe(false);
    }
    expect(batchQuery.andWhere).toHaveBeenCalledWith(
      'batch.updated_at < now() - CAST(:staleAfter AS interval)',
      { staleAfter: '120000 milliseconds' },
    );
  });
});
