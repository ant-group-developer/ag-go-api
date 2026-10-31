import type { DataSource } from 'typeorm';
import type { ActorEnrichmentService } from '../../common/actor-enrichment.service';
import type { UploadSpeedQueryDto } from './dto/upload-speed-query.dto';
import { UploadSpeedService } from './upload-speed.service';

// @nestjs/typeorm is ESM; mock it so Jest can load the service.
jest.mock('@nestjs/typeorm', () => ({
  InjectDataSource: () => () => undefined,
}));

function buildService(rows: Array<Record<string, unknown>> = []) {
  const query = jest
    .fn()
    .mockResolvedValueOnce([
      {
        total: 3,
        failed: 1,
        totalBytes: '3000',
        avgMbps: 12.5,
        medianMbps: 10,
        minMbps: 1.2,
        maxMbps: 40,
        avgTransferMs: 700,
        avgTotalMs: 900,
      },
    ])
    .mockResolvedValueOnce(rows);
  const enrich = jest.fn(async (items: unknown[]) => items);
  const service = new UploadSpeedService(
    { query } as unknown as DataSource,
    { enrich } as unknown as ActorEnrichmentService,
  );
  return { service, query, enrich };
}

function dto(values: Partial<UploadSpeedQueryDto>) {
  return { page: 1, pageSize: 25, ...values } as UploadSpeedQueryDto;
}

describe('UploadSpeedService', () => {
  it('filters by date, file type and mode with bound parameters', async () => {
    const { service, query } = buildService();

    await service.list(
      dto({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-31T23:59:59.999Z',
        assetType: 'video',
        mode: 'multipart',
        page: 2,
        pageSize: 10,
      }),
    );

    const [summarySql] = query.mock.calls[0];
    expect(summarySql).toContain('u.ended_at >= $1');
    expect(summarySql).toContain('u.ended_at <= $2');
    expect(summarySql).toContain('u.asset_type = $3');
    expect(summarySql).toContain('u.mode = $4');
    const [pageSql, pageValues] = query.mock.calls[1];
    expect(pageSql).toContain('OFFSET $5 LIMIT $6');
    expect(pageValues).toEqual([
      '2026-10-01T00:00:00.000Z',
      '2026-10-31T23:59:59.999Z',
      'video',
      'multipart',
      10,
      10,
    ]);
  });

  it('filters by project, folder subtree and uploader', async () => {
    const { service, query } = buildService();

    await service.list(
      dto({
        projectId: '01a166f5-0000-7000-8000-000000000001',
        folderId: '01a166f5-0000-7000-8000-000000000002',
        uploaderId: 'auth0|user-1',
      }),
    );

    const [summarySql] = query.mock.calls[0];
    expect(summarySql).toContain('u.project_id = $1');
    expect(summarySql).toContain('f.id = u.folder_id AND $2::uuid = ANY(f.path_ids)');
    expect(summarySql).toContain('u.created_by = $3');
    const [, pageValues] = query.mock.calls[1];
    expect(pageValues).toEqual([
      '01a166f5-0000-7000-8000-000000000001',
      '01a166f5-0000-7000-8000-000000000002',
      'auth0|user-1',
      0,
      25,
    ]);
  });

  it('filters failed uploads to aborted and expired sessions', async () => {
    const { service, query } = buildService();

    await service.list(dto({ status: 'failed' }));

    const [summarySql] = query.mock.calls[0];
    expect(summarySql).toContain(`u.status IN ('aborted', 'expired')`);
  });

  it('returns the summary and enriches rows with the uploader', async () => {
    const { service, enrich } = buildService([{ uploadSessionId: 's-1', createdBy: 'user-1' }]);

    const result = await service.list(dto({}));

    expect(enrich).toHaveBeenCalledWith(
      [{ uploadSessionId: 's-1', createdBy: 'user-1' }],
      [{ id: 'createdBy', target: 'actorUser' }],
    );
    expect(result.summary).toEqual({
      total: 3,
      failed: 1,
      totalBytes: 3000,
      avgMbps: 12.5,
      medianMbps: 10,
      minMbps: 1.2,
      maxMbps: 40,
      avgTransferMs: 700,
      avgTotalMs: 900,
    });
    expect(result.totalPages).toBe(1);
  });

  it('lists the projects and uploaders found in the log', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'p-1', name: 'Ha Long' }])
      .mockResolvedValueOnce([{ id: 'user-1' }, { id: 'user-2' }]);
    const enrich = jest.fn(async () => [
      { id: 'user-1', user: { id: 'user-1', name: 'Viet Duc', email: 'duc@example.com' } },
      { id: 'user-2', user: null },
    ]);
    const service = new UploadSpeedService(
      { query } as unknown as DataSource,
      { enrich } as unknown as ActorEnrichmentService,
    );

    await expect(service.filterOptions()).resolves.toEqual({
      projects: [{ id: 'p-1', name: 'Ha Long' }],
      uploaders: [
        { id: 'user-1', name: 'Viet Duc', email: 'duc@example.com' },
        { id: 'user-2', name: null, email: null },
      ],
    });
  });
});
