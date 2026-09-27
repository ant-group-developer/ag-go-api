import { StatisticsSummaryService } from './statistics-summary.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
  InjectRepository: () => () => undefined,
}));

describe('StatisticsSummaryService', () => {
  const period = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z' };
  const context = { userId: 'user-1', userType: 'USER' as const };

  function createService(scope: { folderIds: string[] | null; isAdmin: boolean; empty: boolean }) {
    const dataSource = {
      query: jest.fn().mockResolvedValue([
        {
          projects: {
            total: 4,
            draft: 1,
            pending: 1,
            completed: 1,
            partially_completed: 0,
            failed: 1,
            new_current: 2,
            new_previous: 1,
          },
          media: {
            total: 10,
            images: 7,
            videos: 3,
            pending: 4,
            approved: 5,
            rejected: 1,
            oldest_pending_at: '2026-09-02T08:00:00+07:00',
            new_current: 6,
            new_previous: 0,
          },
          decisions: {
            approved_current: 3,
            rejected_current: 1,
            approved_previous: 2,
            rejected_previous: 0,
          },
          storage: { original_bytes: '9007199254740993', rendered_bytes: '12' },
        },
      ]),
    };
    const scopeService = {
      resolve: jest.fn().mockResolvedValue({ ...scope, userId: context.userId }),
    };
    const service = new StatisticsSummaryService(dataSource as never, scopeService as never);
    return { service, dataSource };
  }

  it('maps the snapshot and both windows of the summary row', async () => {
    const { service, dataSource } = createService({
      folderIds: ['folder-1'],
      isAdmin: false,
      empty: false,
    });

    const result = await service.summary(context, period);

    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query.mock.calls[0][1].slice(0, 3)).toEqual([['folder-1'], false, 'user-1']);
    expect(result.snapshot).toEqual({
      projects: 4,
      projectsByStatus: { draft: 1, pending: 1, completed: 1, partially_completed: 0, failed: 1 },
      media: { total: 10, images: 7, videos: 3 },
      evaluation: {
        pending: 4,
        approved: 5,
        rejected: 1,
        oldestPendingAt: '2026-09-02T01:00:00.000Z',
      },
      storage: { originalBytes: '9007199254740993', renderedBytes: '12' },
    });
    expect(result.inPeriod).toEqual({
      newProjects: { current: 2, previous: 1 },
      newMedia: { current: 6, previous: 0 },
      decisions: { approved: { current: 3, previous: 2 }, rejected: { current: 1, previous: 0 } },
    });
    expect(result.period.previousFrom).toBe('2026-08-25T00:00:00.000Z');
  });

  it('passes a null folder list for admins so every folder is counted', async () => {
    const { service, dataSource } = createService({ folderIds: null, isAdmin: true, empty: false });

    await service.summary({ userId: 'admin-1', userType: 'ADMIN' }, period);

    expect(dataSource.query.mock.calls[0][1].slice(0, 2)).toEqual([null, true]);
  });

  it('returns zeros without querying when the user has no folder', async () => {
    const { service, dataSource } = createService({ folderIds: [], isAdmin: false, empty: true });

    const result = await service.summary(context, period);

    expect(dataSource.query).not.toHaveBeenCalled();
    expect(result.snapshot.projects).toBe(0);
    expect(result.snapshot.storage).toEqual({ originalBytes: '0', renderedBytes: '0' });
    expect(result.inPeriod.decisions.approved).toEqual({ current: 0, previous: 0 });
  });
});
