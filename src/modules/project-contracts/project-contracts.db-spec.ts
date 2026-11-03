/**
 * DB-level tests of project ↔ contract links and technical checks (ANTGO-252): delivery and
 * automatic linking from the evaluation recalculation, manual linking rules, checks stored per
 * video and refreshed when an analysis completes or an amendment changes the tech spec, the outside
 * acceptance and the missing-analysis queue. Folder access and AG Account are mocked; runs against
 * real Postgres (docker-compose.test.yml).
 */
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxService } from '../../common/outbox.service';
import { AppDataSource } from '../../database/data-source';
import { ContractAmendmentEntity } from '../../database/entities/contract-amendment.entity';
import { ContractEntity } from '../../database/entities/contract.entity';
import { OutboxEventEntity } from '../../database/entities/outbox-event.entity';
import { PartnerEntity } from '../../database/entities/partner.entity';
import type { AccountApiService } from '../account/account-api.service';
import { AnalysisEnqueueService } from '../analysis/analysis-enqueue.service';
import type { AuditService } from '../audit/audit.service';
import { TECH_SPEC_PRESETS } from '../contracts/contract-terms';
import { ContractsService } from '../contracts/contracts.service';
import { documentsStub } from '../documents/testing/documents-stub';
import type { FolderAccessService } from '../folders/folder-access.service';
import type { SystemLogService } from '../logs/system-log.service';
import { refreshProjectMediaSummary } from '../media/project-media-summary';
import type { PartnerActor } from '../partners/partner-actor';
import { PartnersService } from '../partners/partners.service';
import { ListPartnerProjectsQueryDto } from './dto/project-contract.dto';
import { ProjectContractsOutboxService } from './project-contracts-outbox.service';
import { ProjectContractsService } from './project-contracts.service';
import { contractDay, recordProjectDelivery } from './project-delivery';
import { SpecChecksService } from './spec-checks.service';

jest.mock('@nestjs/typeorm', () => ({
  InjectRepository: () => () => undefined,
  InjectDataSource: () => () => undefined,
}));
// The ESM build of uuid does not load under ts-jest.
jest.mock('uuid', () => ({ v7: () => jest.requireActual('node:crypto').randomUUID() }));

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:55434/ag_go_test';

const suffix = randomUUID().slice(0, 6).toUpperCase();
const manager: PartnerActor = {
  userId: `mgr-${suffix}`,
  userType: 'USER',
  permissions: [
    'go.project.read',
    'go.project.edit',
    'go.partner.read',
    'go.contract.read',
    'go.contract.manage',
  ],
};
const footage = TECH_SPEC_PRESETS.footage_4k60.techSpec;

let ds: DataSource;
let service: ProjectContractsService;
let outbox: ProjectContractsOutboxService;
let specChecks: SpecChecksService;
let autoEnqueue = false;
const audit = { recordMany: jest.fn().mockResolvedValue(undefined) };
let folderId: string;
const partnerIds: string[] = [];
const assetIds: string[] = [];

beforeAll(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  Object.assign(AppDataSource.options, { url: TEST_DB_URL, schema: 'public' });
  await AppDataSource.initialize();
  ds = AppDataSource;
  const systemLog = {
    write: jest.fn().mockResolvedValue(undefined),
  } as unknown as SystemLogService;
  const partners = new PartnersService(
    ds.getRepository(PartnerEntity),
    {} as AccountApiService,
    systemLog,
  );
  const contracts = new ContractsService(
    ds,
    ds.getRepository(ContractEntity),
    ds.getRepository(ContractAmendmentEntity),
    ds.getRepository(PartnerEntity),
    partners,
    {} as never,
    systemLog,
    documentsStub(),
  );
  const config = {
    get: (name: string) => (name === 'ANALYSIS_AUTO_ENQUEUE' ? autoEnqueue : undefined),
  } as unknown as ConfigService;
  const enqueue = new AnalysisEnqueueService(
    new OutboxService(ds.getRepository(OutboxEventEntity)),
    config,
  );
  specChecks = new SpecChecksService(ds);
  outbox = new ProjectContractsOutboxService(ds, specChecks, enqueue);
  service = new ProjectContractsService(
    ds,
    specChecks,
    outbox,
    contracts,
    partners,
    { canViewProject: jest.fn().mockResolvedValue(true) } as unknown as FolderAccessService,
    audit as unknown as AuditService,
  );
  folderId = randomUUID();
  await ds.query(
    `INSERT INTO folders (id, parent_id, name, path_key, path_ids, path_text, depth, sort_order, is_active, created_by)
     VALUES ($1, NULL, $2, $3, '{}', $4, 0, 0, true, 'test')`,
    [folderId, `Folder ${folderId.slice(0, 8)}`, `/${folderId}`, `Folder ${folderId.slice(0, 8)}`],
  );
});

afterAll(async () => {
  if (ds?.isInitialized) {
    await ds.query(`DELETE FROM projects WHERE folder_id = $1`, [folderId]);
    await ds.query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [assetIds]);
    await ds.query(`DELETE FROM contracts WHERE partner_id = ANY($1::uuid[])`, [partnerIds]);
    await ds.query(`DELETE FROM partners WHERE id = ANY($1::uuid[])`, [partnerIds]);
    await ds.query(`DELETE FROM folders WHERE id = $1`, [folderId]);
    await ds.destroy();
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let codeCounter = 0;

async function insertPartner(status = 'active') {
  const id = randomUUID();
  const goUserId = `go-${randomUUID()}`;
  codeCounter += 1;
  await ds.query(
    `INSERT INTO partners (id, account_user_id, go_user_id, code, display_name, manager_user_id, status, created_by)
     VALUES ($1, $2, $3, $4, 'Nguyễn Văn Test', $5, $6, 'test')`,
    [id, randomUUID(), goUserId, `T${suffix}${codeCounter}`, manager.userId, status],
  );
  partnerIds.push(id);
  return { id, goUserId };
}

async function insertContract(
  partnerId: string,
  options: {
    status?: string;
    startDate?: string;
    endDate?: string | null;
    techSpec?: Record<string, unknown>;
    pricingModel?: string;
    pricingConfig?: Record<string, unknown>;
  } = {},
) {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO contracts (id, partner_id, contract_number, start_date, end_date, status, pricing_model,
       pricing_config, acceptance_cycle, payment_term_business_days, tech_spec, manager_user_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'monthly', 10, $9, $10, 'test')`,
    [
      id,
      partnerId,
      `${id.slice(0, 8)}/HĐSXND/AG-T`,
      options.startDate ?? '2026-01-01',
      options.endDate ?? null,
      options.status ?? 'active',
      options.pricingModel ?? 'package_tier',
      JSON.stringify(
        options.pricingConfig ?? {
          rate_card_id: 'CTV',
          level: 'LV1',
          category_ids: [randomUUID()],
          employment_stage: 'official',
        },
      ),
      JSON.stringify(options.techSpec ?? footage),
      manager.userId,
    ],
  );
  return id;
}

async function insertProject(ownerUserId: string, evaluationStatus = 'draft') {
  const id = randomUUID();
  await ds.query(
    `INSERT INTO projects (id, owner_user_id, folder_id, name, evaluation_status)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, ownerUserId, folderId, `Project ${id.slice(0, 8)}`, evaluationStatus],
  );
  return id;
}

async function insertVideo(
  projectId: string,
  options: { evaluationStatus?: string; processingStatus?: string } = {},
) {
  const assetId = randomUUID();
  await ds.query(
    `INSERT INTO assets (id, asset_type, original_filename, mime_type, file_size_bytes, storage_provider,
       original_bucket, original_storage_key, processing_status, source_type, source_metadata, created_by)
     VALUES ($1, 'video', $2, 'video/mp4', 1024, 'r2', 'ag-go', $3, $4, 'local', '{}', 'test')`,
    [
      assetId,
      `clip-${assetId.slice(0, 6)}.mp4`,
      `projects/${projectId}/originals/${assetId}.mp4`,
      options.processingStatus ?? 'ready',
    ],
  );
  assetIds.push(assetId);
  const mediaId = randomUUID();
  await ds.query(
    `INSERT INTO project_media (id, project_id, asset_id, sort_order, evaluation_status, created_by)
     VALUES ($1, $2, $3, (SELECT count(*) FROM project_media WHERE project_id = $2), $4, 'test')`,
    [mediaId, projectId, assetId, options.evaluationStatus ?? 'pending'],
  );
  return { assetId, mediaId };
}

/** A completed current analysis, 4K60 25 s by default. */
async function completeAnalysis(
  assetId: string,
  media: { width?: number; height?: number; fps?: number; durationMs?: number } = {},
  technical: Record<string, unknown> = { dead: false, dead_reason: null },
) {
  await ds.query(`UPDATE asset_analyses SET is_current = false WHERE asset_id = $1`, [assetId]);
  const id = randomUUID();
  await ds.query(
    `INSERT INTO asset_analyses (id, asset_id, status, extract_version, prompt_version, is_current,
       artifacts, technical, duration_ms, has_audio, usable, quality, completed_at)
     VALUES ($1, $2, 'completed', 'x2', 'p2', true, $3, $4, $5, true, $6, 4, now())`,
    [
      id,
      assetId,
      JSON.stringify({
        media: {
          width: media.width ?? 3840,
          height: media.height ?? 2160,
          fps: media.fps ?? 59.94,
        },
      }),
      JSON.stringify(technical),
      media.durationMs ?? 25_000,
      technical.dead === true ? false : true,
    ],
  );
  return id;
}

async function project(id: string) {
  const [row] = (await ds.query(
    `SELECT contract_id AS "contractId", delivered_at AS "deliveredAt" FROM projects WHERE id = $1`,
    [id],
  )) as Array<{ contractId: string | null; deliveredAt: Date | null }>;
  return row;
}

function inTransaction<T>(work: (entityManager: EntityManager) => Promise<T>) {
  return ds.transaction(work);
}

// ---------------------------------------------------------------------------

describe('delivery and automatic link (FR-P-09, spec 7.4)', () => {
  it('delivers on the first pending and links the only contract in force, queuing its checks', async () => {
    const partner = await insertPartner();
    const contractId = await insertContract(partner.id);
    const projectId = await insertProject(partner.goUserId);
    await insertVideo(projectId);

    // Media added → the summary goes to pending (as uploads and Drive imports do).
    await inTransaction((entityManager) => refreshProjectMediaSummary(entityManager, projectId));

    const row = await project(projectId);
    expect(row.contractId).toBe(contractId);
    expect(row.deliveredAt).toBeInstanceOf(Date);
    const events = (await ds.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'project.spec_checks.requested'
         AND aggregate_id = $1`,
      [projectId],
    )) as Array<{ payload: { projectId: string } }>;
    expect(events).toEqual([{ payload: { projectId } }]);
    const logs = (await ds.query(
      `SELECT actor_user_id AS actor, metadata FROM project_audit_logs
       WHERE project_id = $1 AND action = 'contract_linked'`,
      [projectId],
    )) as Array<{ actor: string; metadata: { source: string } }>;
    expect(logs).toEqual([
      { actor: 'system', metadata: expect.objectContaining({ source: 'auto' }) },
    ]);

    // Later passes through pending change nothing.
    const first = row.deliveredAt!.getTime();
    await inTransaction((entityManager) =>
      recordProjectDelivery(entityManager, projectId, 'pending'),
    );
    expect((await project(projectId)).deliveredAt!.getTime()).toBe(first);
  });

  it('leaves the project unlinked when the partner has several contracts in force', async () => {
    const partner = await insertPartner();
    const first = await insertContract(partner.id, { startDate: '2026-01-01' });
    const second = await insertContract(partner.id, { startDate: '2026-02-01' });
    const projectId = await insertProject(partner.goUserId);
    await insertVideo(projectId);

    await inTransaction((entityManager) => refreshProjectMediaSummary(entityManager, projectId));

    const row = await project(projectId);
    expect(row.contractId).toBeNull();
    expect(row.deliveredAt).toBeInstanceOf(Date);
    const link = await service.getLink(projectId, manager);
    expect(link.partner?.id).toBe(partner.id);
    expect(link.candidateDay).toBe(contractDay(row.deliveredAt!));
    // Latest start first.
    expect(link.candidates.map((candidate) => candidate.id)).toEqual([second, first]);

    const unlinked = await service.listPartnerProjects(
      partner.id,
      Object.assign(new ListPartnerProjectsQueryDto(), { link: 'unlinked', delivered: 'true' }),
      manager,
    );
    expect(unlinked.items.map((item) => item.id)).toEqual([projectId]);
  });

  it('ignores contracts not active, not started, ended, and inactive partners', async () => {
    const partner = await insertPartner();
    await insertContract(partner.id, { status: 'suspended' });
    await insertContract(partner.id, { status: 'draft' });
    await insertContract(partner.id, { startDate: '2999-01-01' });
    await insertContract(partner.id, { startDate: '2025-01-01', endDate: '2025-12-31' });
    const projectId = await insertProject(partner.goUserId);
    await insertVideo(projectId);
    await inTransaction((entityManager) => refreshProjectMediaSummary(entityManager, projectId));
    expect((await project(projectId)).contractId).toBeNull();

    const inactive = await insertPartner('inactive');
    await insertContract(inactive.id);
    const other = await insertProject(inactive.goUserId);
    await insertVideo(other);
    await inTransaction((entityManager) => refreshProjectMediaSummary(entityManager, other));
    expect((await project(other)).contractId).toBeNull();
  });

  it('does not deliver a project that has no media yet', async () => {
    const partner = await insertPartner();
    await insertContract(partner.id);
    const projectId = await insertProject(partner.goUserId);
    await inTransaction((entityManager) => refreshProjectMediaSummary(entityManager, projectId));
    expect(await project(projectId)).toEqual({ contractId: null, deliveredAt: null });
  });
});

describe('manual link (FR-C-08)', () => {
  it("refuses another partner's contract and a contract that is not active", async () => {
    const owner = await insertPartner();
    const other = await insertPartner();
    const otherContract = await insertContract(other.id);
    const suspended = await insertContract(owner.id, { status: 'suspended' });
    const projectId = await insertProject(owner.goUserId, 'pending');

    await expect(
      service.update(projectId, { contractId: otherContract }, manager),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_OTHER_PARTNER' } });
    await expect(
      service.update(projectId, { contractId: suspended }, manager),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_ACTIVE' } });
    await expect(
      service.update(projectId, { contractId: randomUUID() }, manager),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_FOUND' } });
    expect((await project(projectId)).contractId).toBeNull();
  });

  it('refuses a contract the actor does not manage without contract.read_all', async () => {
    const owner = await insertPartner();
    const contractId = await insertContract(owner.id);
    await ds.query(`UPDATE contracts SET manager_user_id = 'someone-else' WHERE id = $1`, [
      contractId,
    ]);
    const projectId = await insertProject(owner.goUserId, 'pending');
    await expect(service.update(projectId, { contractId }, manager)).rejects.toMatchObject({
      response: { code: 'CONTRACT_NOT_FOUND' },
    });
  });

  it('needs go.contract.manage to change the delivery time or the outside acceptance', async () => {
    const owner = await insertPartner();
    const projectId = await insertProject(owner.goUserId, 'pending');
    const reader = { ...manager, permissions: ['go.project.edit', 'go.contract.read'] };
    await expect(
      service.update(projectId, { deliveredAt: '2026-05-01T00:00:00Z' }, reader),
    ).rejects.toMatchObject({ response: { code: 'CONTRACT_MANAGE_REQUIRED' } });
    await expect(
      service.update(projectId, { deliveredAt: '2999-01-01T00:00:00Z' }, manager),
    ).rejects.toMatchObject({ response: { code: 'PROJECT_DELIVERED_AT_INVALID' } });
  });

  it('links, queues the missing analyses, checks, then unlinks', async () => {
    const owner = await insertPartner();
    const first = await insertContract(owner.id);
    const second = await insertContract(owner.id);
    const projectId = await insertProject(owner.goUserId, 'pending');
    const good = await insertVideo(projectId);
    await completeAnalysis(good.assetId);
    const waiting = await insertVideo(projectId);

    const linked = await service.update(projectId, { contractId: first }, manager);

    expect(linked.contractId).toBe(first);
    expect(linked.contract?.contractNumber).toContain('/HĐSXND/');
    expect(linked.candidates.map((candidate) => candidate.id).sort()).toEqual(
      [first, second].sort(),
    );
    // FR-T-01: the video without analysis got one queued.
    expect(linked.queuedAnalyses).toBe(1);
    const queued = (await ds.query(`SELECT status FROM asset_analyses WHERE asset_id = $1`, [
      waiting.assetId,
    ])) as Array<{ status: string }>;
    expect(queued).toEqual([{ status: 'queued' }]);
    expect(linked.specChecks?.state).toBe('checked');
    const byMedia = new Map(linked.specChecks!.media.map((item) => [item.projectMediaId, item]));
    expect(byMedia.get(good.mediaId)?.result).toBe('pass');
    expect(byMedia.get(waiting.mediaId)).toMatchObject({
      result: 'unknown',
      findings: [expect.objectContaining({ rule: 'analysis', actual: 'queued' })],
    });
    expect(audit.recordMany).toHaveBeenLastCalledWith([
      expect.objectContaining({ action: 'contract_linked', projectId }),
    ]);

    // Moving to the other contract replaces the rows.
    await service.update(projectId, { contractId: second }, manager);
    const rows = (await ds.query(
      `SELECT DISTINCT contract_id AS "contractId" FROM media_spec_checks WHERE project_id = $1`,
      [projectId],
    )) as Array<{ contractId: string }>;
    expect(rows).toEqual([{ contractId: second }]);

    const unlinked = await service.update(projectId, { contractId: null }, manager);
    expect(unlinked.contractId).toBeNull();
    expect(unlinked.specChecks?.state).toBe('no_contract');
    expect(
      await ds.query(`SELECT 1 FROM media_spec_checks WHERE project_id = $1`, [projectId]),
    ).toEqual([]);
  });
});

describe('technical checks (FR-T-02, FR-T-03, FR-T-05)', () => {
  it('stores a result per video, reuses it, and updates it when the analysis completes', async () => {
    const owner = await insertPartner();
    const contractId = await insertContract(owner.id);
    const projectId = await insertProject(owner.goUserId, 'pending');
    await ds.query(`UPDATE projects SET contract_id = $2, delivered_at = now() WHERE id = $1`, [
      projectId,
      contractId,
    ]);
    const good = await insertVideo(projectId, { evaluationStatus: 'approved' });
    await completeAnalysis(good.assetId);
    const hd = await insertVideo(projectId);
    await completeAnalysis(hd.assetId, { width: 1920, height: 1080, fps: 29.97 });
    const black = await insertVideo(projectId);
    await completeAnalysis(black.assetId, {}, { dead: true, dead_reason: 'black' });
    const later = await insertVideo(projectId);

    const checks = await service.getSpecChecks(projectId, manager);
    const results = new Map(checks!.media.map((item) => [item.projectMediaId, item]));
    expect(results.get(good.mediaId)?.result).toBe('pass');
    expect(results.get(hd.mediaId)?.result).toBe('fail');
    expect(results.get(hd.mediaId)?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'resolution', level: 'fail', actual: '1920x1080' }),
        expect.objectContaining({ rule: 'fps', level: 'fail', actual: 29.97 }),
      ]),
    );
    expect(results.get(black.mediaId)?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'dead', actual: 'black' })]),
    );
    expect(results.get(later.mediaId)?.result).toBe('unknown');
    expect(checks!.summary).toMatchObject({
      result: 'fail',
      counts: { total: 4, pass: 1, fail: 2, unknown: 1 },
      approvedVideos: 1,
    });
    expect(checks!.summary!.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'min_shots_per_scene', level: 'unknown' }),
        expect.objectContaining({ rule: 'uniform_within_project', level: 'warn' }),
      ]),
    );
    expect(checks!.termsDate).toBe(contractDay(new Date()));

    // A second read reuses the stored row of a checked video.
    const storedAt = (await ds.query(
      `SELECT checked_at AS "checkedAt" FROM media_spec_checks WHERE project_media_id = $1`,
      [good.mediaId],
    )) as Array<{ checkedAt: Date }>;
    await specChecks.refreshProject(projectId);
    const again = (await ds.query(
      `SELECT checked_at AS "checkedAt" FROM media_spec_checks WHERE project_media_id = $1`,
      [good.mediaId],
    )) as Array<{ checkedAt: Date }>;
    expect(again[0].checkedAt.getTime()).toBe(storedAt[0].checkedAt.getTime());

    // asset.analysis.completed for the last video (outbox consumer).
    const analysisId = await completeAnalysis(later.assetId, { durationMs: 8_000 });
    await outbox.handleAnalysisCompleted(later.assetId);
    const [row] = (await ds.query(
      `SELECT result, analysis_id AS "analysisId", findings FROM media_spec_checks
       WHERE project_media_id = $1`,
      [later.mediaId],
    )) as Array<{ result: string; analysisId: string; findings: Array<{ rule: string }> }>;
    expect(row).toMatchObject({ result: 'warn', analysisId });
    expect(row.findings.map((finding) => finding.rule)).toContain('source_min_seconds');

    // Project lists read the stored counts.
    const counts = await specChecks.countsForProjects([projectId]);
    expect(counts.get(projectId)).toEqual({ pass: 1, warn: 1, fail: 2, unknown: 0 });
  });

  it('applies the tech spec of the signed amendments in force on the delivery day', async () => {
    const owner = await insertPartner();
    const contractId = await insertContract(owner.id);
    const projectId = await insertProject(owner.goUserId, 'pending');
    await ds.query(
      `UPDATE projects SET contract_id = $2, delivered_at = '2026-06-10T03:00:00Z' WHERE id = $1`,
      [projectId, contractId],
    );
    const hd = await insertVideo(projectId);
    await completeAnalysis(hd.assetId, { width: 1920, height: 1080, fps: 59.94 });
    const hdSpec = { ...footage, min_width: 1920, min_height: 1080 };
    const amendmentId = randomUUID();
    await ds.query(
      `INSERT INTO contract_amendments (id, contract_id, amendment_number, effective_date, changes, status, created_by)
       VALUES ($1, $2, 1, '2026-07-01', $3, 'signed', 'test')`,
      [amendmentId, contractId, JSON.stringify({ tech_spec: hdSpec })],
    );

    const before = await specChecks.refreshProject(projectId);
    expect(before!.appliedAmendments).toEqual([]);
    expect(before!.termsDate).toBe('2026-06-10');
    expect(before!.media[0].result).toBe('fail');

    await ds.query(`UPDATE contract_amendments SET effective_date = '2026-06-01' WHERE id = $1`, [
      amendmentId,
    ]);
    const after = await specChecks.refreshProject(projectId);
    expect(after!.appliedAmendments).toEqual([1]);
    expect(after!.specHash).not.toBe(before!.specHash);
    expect(after!.media[0].result).toBe('pass');
  });

  it('skips a project accepted outside AG Go (spec 15.3) and checks it again once unmarked', async () => {
    const owner = await insertPartner();
    const contractId = await insertContract(owner.id);
    const projectId = await insertProject(owner.goUserId, 'pending');
    const video = await insertVideo(projectId);
    await completeAnalysis(video.assetId);
    await service.update(projectId, { contractId }, manager);

    const marked = await service.update(
      projectId,
      { acceptedOutside: true, acceptedOutsideNote: 'BBNT giấy số 4' },
      manager,
    );
    expect(marked.acceptedOutsideAt).toBeInstanceOf(Date);
    expect(marked.acceptedOutsideNote).toBe('BBNT giấy số 4');
    expect(marked.specChecks?.state).toBe('accepted_outside');
    expect(
      await ds.query(`SELECT 1 FROM media_spec_checks WHERE project_id = $1`, [projectId]),
    ).toEqual([]);
    expect(await specChecks.refreshAsset(video.assetId)).toBe(0);

    const unmarked = await service.update(projectId, { acceptedOutside: false }, manager);
    expect(unmarked.acceptedOutsideAt).toBeNull();
    expect(unmarked.specChecks?.media[0].result).toBe('pass');
  });

  it('queues missing analyses on a check request only when automatic analysis is on', async () => {
    const owner = await insertPartner();
    const contractId = await insertContract(owner.id);
    const projectId = await insertProject(owner.goUserId, 'pending');
    await ds.query(`UPDATE projects SET contract_id = $2 WHERE id = $1`, [projectId, contractId]);
    const ready = await insertVideo(projectId);
    const processing = await insertVideo(projectId, { processingStatus: 'processing' });

    autoEnqueue = false;
    await outbox.handleSpecChecksRequested(projectId);
    expect(
      await ds.query(`SELECT 1 FROM asset_analyses WHERE asset_id = ANY($1::uuid[])`, [
        [ready.assetId, processing.assetId],
      ]),
    ).toEqual([]);

    autoEnqueue = true;
    try {
      await outbox.handleSpecChecksRequested(projectId);
    } finally {
      autoEnqueue = false;
    }
    const analyses = (await ds.query(
      `SELECT asset_id AS "assetId", status FROM asset_analyses WHERE asset_id = ANY($1::uuid[])`,
      [[ready.assetId, processing.assetId]],
    )) as Array<{ assetId: string; status: string }>;
    // Still-processing assets get their analysis when their render finishes.
    expect(analyses).toEqual([{ assetId: ready.assetId, status: 'queued' }]);
    const recheck = await service.recheck(projectId, manager);
    // Already in flight: nothing more queued.
    expect(recheck.queuedAnalyses).toBe(0);
    expect(recheck.media.map((item) => item.result)).toEqual(['unknown', 'unknown']);
  });
});

describe('migration 2200000000000', () => {
  it('has the columns, the FK restricting contract deletion and the result check', async () => {
    const owner = await insertPartner();
    const contractId = await insertContract(owner.id);
    const projectId = await insertProject(owner.goUserId, 'pending');
    await ds.query(`UPDATE projects SET contract_id = $2 WHERE id = $1`, [projectId, contractId]);
    await expect(ds.query(`DELETE FROM contracts WHERE id = $1`, [contractId])).rejects.toThrow(
      /foreign key/,
    );
    const video = await insertVideo(projectId);
    await expect(
      ds.query(
        `INSERT INTO media_spec_checks (project_media_id, project_id, contract_id, spec_hash, terms_date, result)
         VALUES ($1, $2, $3, repeat('a', 64), '2026-01-01', 'maybe')`,
        [video.mediaId, projectId, contractId],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
