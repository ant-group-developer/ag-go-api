import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import {
  DataRetentionService,
  DEFAULT_RETENTION_LOG_ACT_AS_DAYS,
  DEFAULT_RETENTION_LOG_ANALYSIS_DAYS,
  DEFAULT_RETENTION_LOG_SYSTEM_DAYS,
  DEFAULT_RETENTION_OUTBOX_DEAD_DAYS,
  DEFAULT_RETENTION_OUTBOX_PUBLISHED_DAYS,
  DEFAULT_RETENTION_STUDIO_USAGE_DAYS,
  DEFAULT_RETENTION_STUDIO_USAGE_REMOVED_DAYS,
} from './data-retention.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('DataRetentionService', () => {
  let dataSource: jest.Mocked<DataSource>;
  let config: jest.Mocked<ConfigService>;
  let service: DataRetentionService;

  beforeEach(() => {
    dataSource = {
      query: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<DataSource>;

    config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;

    service = new DataRetentionService(dataSource, config);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('runs all retention queries with default cutoffs', async () => {
    // 1st query: outbox returns 2 rows
    // 2nd query: system_logs returns 1 row
    // 3rd query: studio_usage returns 3 rows
    dataSource.query
      .mockResolvedValueOnce([{ id: 'outbox-1' }, { id: 'outbox-2' }])
      .mockResolvedValueOnce([{ id: 'log-1' }])
      .mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }]);

    const result = await service.runRetention();

    expect(result).toEqual({
      outboxDeleted: 2,
      systemLogsDeleted: 1,
      studioUsageDeleted: 3,
    });

    expect(dataSource.query).toHaveBeenCalledTimes(3);

    // Verify outbox query args
    const outboxCall = dataSource.query.mock.calls[0];
    expect(outboxCall[0]).toContain('DELETE FROM outbox_events');
    const [publishedCutoff, deadCutoff] = outboxCall[1] as [Date, Date];
    const now = Date.now();
    expect(publishedCutoff.getTime()).toBeLessThan(
      now - (DEFAULT_RETENTION_OUTBOX_PUBLISHED_DAYS - 1) * 86_400_000,
    );
    expect(deadCutoff.getTime()).toBeLessThan(
      now - (DEFAULT_RETENTION_OUTBOX_DEAD_DAYS - 1) * 86_400_000,
    );

    // Verify system logs query args
    const systemLogCall = dataSource.query.mock.calls[1];
    expect(systemLogCall[0]).toContain('DELETE FROM system_logs');
    const [actAsCutoff, analysisCutoff, systemLogCutoff] = systemLogCall[1] as [Date, Date, Date];
    expect(actAsCutoff.getTime()).toBeLessThan(
      now - (DEFAULT_RETENTION_LOG_ACT_AS_DAYS - 1) * 86_400_000,
    );
    expect(analysisCutoff.getTime()).toBeLessThan(
      now - (DEFAULT_RETENTION_LOG_ANALYSIS_DAYS - 1) * 86_400_000,
    );
    expect(systemLogCutoff.getTime()).toBeLessThan(
      now - (DEFAULT_RETENTION_LOG_SYSTEM_DAYS - 1) * 86_400_000,
    );

    // Verify studio usage query args
    const usageCall = dataSource.query.mock.calls[2];
    expect(usageCall[0]).toContain('DELETE FROM studio_usage_events');
    const [removedCutoff, usageCutoff] = usageCall[1] as [Date, Date];
    expect(removedCutoff.getTime()).toBeLessThan(
      now - (DEFAULT_RETENTION_STUDIO_USAGE_REMOVED_DAYS - 1) * 86_400_000,
    );
    expect(usageCutoff.getTime()).toBeLessThan(
      now - (DEFAULT_RETENTION_STUDIO_USAGE_DAYS - 1) * 86_400_000,
    );
  });

  it('batches deletion when batch limit is reached', async () => {
    const fullBatch = Array.from({ length: 5000 }, (_, i) => ({ id: `id-${i}` }));
    const partialBatch = [{ id: 'last-id' }];

    // Outbox: 1 full batch, then 1 partial batch
    // System logs: 0
    // Studio usage: 0
    dataSource.query
      .mockResolvedValueOnce(fullBatch)
      .mockResolvedValueOnce(partialBatch)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.runRetention();

    expect(result.outboxDeleted).toBe(5001);
    expect(dataSource.query).toHaveBeenCalledTimes(4);
  });

  it('survives an error in one purge category and continues remaining ones', async () => {
    dataSource.query
      .mockRejectedValueOnce(new Error('Outbox DB error'))
      .mockResolvedValueOnce([{ id: 'log-1' }])
      .mockResolvedValueOnce([{ id: '1' }]);

    const result = await service.runRetention();

    expect(result.outboxDeleted).toBe(0);
    expect(result.systemLogsDeleted).toBe(1);
    expect(result.studioUsageDeleted).toBe(1);
  });

  it('deduplicates concurrent runRetention calls', async () => {
    let resolveQuery: (value: unknown[]) => void;
    const pendingQuery = new Promise<unknown[]>((resolve) => {
      resolveQuery = resolve;
    });

    dataSource.query.mockImplementation(() => pendingQuery);

    const call1 = service.runRetention();
    const call2 = service.runRetention();

    resolveQuery!([]);
    const [res1, res2] = await Promise.all([call1, call2]);

    expect(res1).toBe(res2);
    expect(dataSource.query).toHaveBeenCalledTimes(3);
  });

  it('uses custom retention days configured in ConfigService', async () => {
    config.get.mockImplementation((key: string) => {
      if (key === 'RETENTION_OUTBOX_PUBLISHED_DAYS') return 3;
      if (key === 'RETENTION_OUTBOX_DEAD_DAYS') return 10;
      if (key === 'RETENTION_LOG_ACT_AS_DAYS') return 15;
      if (key === 'RETENTION_LOG_ANALYSIS_DAYS') return 15;
      if (key === 'RETENTION_LOG_SYSTEM_DAYS') return 45;
      if (key === 'RETENTION_STUDIO_USAGE_REMOVED_DAYS') return 14;
      if (key === 'RETENTION_STUDIO_USAGE_DAYS') return 60;
      return undefined;
    });

    dataSource.query.mockResolvedValue([]);

    await service.runRetention();

    const now = Date.now();
    const outboxCall = dataSource.query.mock.calls[0];
    const [publishedCutoff, deadCutoff] = outboxCall[1] as [Date, Date];
    // roughly 3 days ago
    expect(now - publishedCutoff.getTime()).toBeGreaterThanOrEqual(2.9 * 86_400_000);
    expect(now - publishedCutoff.getTime()).toBeLessThan(3.1 * 86_400_000);
    // roughly 10 days ago
    expect(now - deadCutoff.getTime()).toBeGreaterThanOrEqual(9.9 * 86_400_000);
    expect(now - deadCutoff.getTime()).toBeLessThan(10.1 * 86_400_000);
  });
});
