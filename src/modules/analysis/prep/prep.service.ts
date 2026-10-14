import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { OutboxService } from '../../../common/outbox.service';
import {
  AssetPrepBatchEntity,
  type AssetPrepBatchStatus,
} from '../../../database/entities/asset-prep-batch.entity';
import {
  AssetPrepEntity,
  PREP_UNFINISHED_STATUSES,
} from '../../../database/entities/asset-prep.entity';
import { FarmClient } from '../farm/farm-client';
import {
  ASSET_PREP_REQUESTED_EVENT,
  BATCH_PREP_PRIORITY,
  PREP_JOB_TYPES,
  prepBatchGroupKey,
} from './prep-batches';
import { PrepPipelineService } from './prep-pipeline.service';

/** Assets whose original is stored (the same set the analysis backfill works on). */
const ORIGINAL_STORED_STATUSES = ['uploaded', 'processing', 'ready', 'failed'];
/** Rows inserted per statement when a backfill is created. */
const INSERT_CHUNK = 500;
/** Batches `GET /prep/stats` lists, newest first. */
const STATS_BATCHES = 20;

export type PrepCounts = {
  ready: number;
  running: number;
  failed: number;
  missing: number;
  total: number;
};

export type PrepBatchView = {
  id: string;
  name: string;
  mode: string;
  status: AssetPrepBatchStatus | 'completed';
  total: number;
  done: number;
  failed: number;
  createdAt: Date;
};

/**
 * Video footage a prep is made for: video assets with a stored original, linked to a project.
 * `$1`: the stored statuses.
 */
const CANDIDATES_CTE = `candidates AS (
  SELECT DISTINCT a.id
  FROM assets a
  JOIN project_media pm ON pm.asset_id = a.id
  WHERE a.asset_type = 'video' AND a.processing_status = ANY($1::text[])
)`;

/**
 * Prep counts for the analysis page, the backfill of footage without a prep (or all of it), and
 * pause / resume / cancel of a backfill batch.
 */
@Injectable()
export class PrepService {
  private readonly logger = new Logger(PrepService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AssetPrepEntity)
    private readonly prepRepo: Repository<AssetPrepEntity>,
    @InjectRepository(AssetPrepBatchEntity)
    private readonly batchRepo: Repository<AssetPrepBatchEntity>,
    private readonly pipeline: PrepPipelineService,
    private readonly farmClient: FarmClient,
    private readonly outboxService: OutboxService,
  ) {}

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  /**
   * Footage by prep state: `ready` has a current prep (even while a newer one runs), otherwise the
   * latest prep says `running` or `failed`, and `missing` covers the rest (none, or cancelled).
   */
  async stats(): Promise<{ counts: PrepCounts; batches: PrepBatchView[] }> {
    const [row] = await this.dataSource.query<
      { total: string; ready: string; running: string; failed: string }[]
    >(
      `WITH ${CANDIDATES_CTE},
       latest AS (
         SELECT DISTINCT ON (p.asset_id) p.asset_id, p.status
         FROM asset_preps p
         JOIN candidates c ON c.id = p.asset_id
         ORDER BY p.asset_id, p.created_at DESC, p.id DESC
       )
       SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE cur.id IS NOT NULL) AS ready,
              COUNT(*) FILTER (WHERE cur.id IS NULL AND l.status IN ('queued','cutting','transcribing')) AS running,
              COUNT(*) FILTER (WHERE cur.id IS NULL AND l.status = 'failed') AS failed
       FROM candidates c
       LEFT JOIN latest l ON l.asset_id = c.id
       LEFT JOIN asset_preps cur ON cur.asset_id = c.id AND cur.is_current`,
      [ORIGINAL_STORED_STATUSES],
    );
    const total = Number(row?.total ?? 0);
    const ready = Number(row?.ready ?? 0);
    const running = Number(row?.running ?? 0);
    const failed = Number(row?.failed ?? 0);
    const batches = await this.batchRepo.find({
      order: { createdAt: 'DESC' },
      take: STATS_BATCHES,
    });
    return {
      counts: { ready, running, failed, missing: total - ready - running - failed, total },
      batches: await this.views(batches),
    };
  }

  // ---------------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------------

  /**
   * Queues a prep, lane `batch` at low priority, for every footage without one (`missing`) or for
   * all of it (`all`); footage whose prep is running is skipped. The batch and its preps are
   * created together. `dryRun` only counts.
   */
  async backfill(input: {
    mode: 'missing' | 'all';
    dryRun?: boolean;
    requestedBy: string | null;
  }): Promise<{ batchId: string | null; count: number }> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `WITH ${CANDIDATES_CTE}
       SELECT c.id FROM candidates c
       WHERE NOT EXISTS (
               SELECT 1 FROM asset_preps p
               WHERE p.asset_id = c.id AND p.status IN ('queued','cutting','transcribing'))
         AND ($2::boolean OR NOT EXISTS (
               SELECT 1 FROM asset_preps p WHERE p.asset_id = c.id AND p.is_current))
       ORDER BY c.id`,
      [ORIGINAL_STORED_STATUSES, input.mode === 'all'],
    );
    const assetIds = rows.map((r) => r.id);
    if (input.dryRun || assetIds.length === 0) {
      return { batchId: null, count: assetIds.length };
    }

    const batchId = await this.dataSource.transaction(async (manager) => {
      const batch = await manager.save(
        manager.create(AssetPrepBatchEntity, {
          name: input.mode === 'all' ? 'Chuẩn bị lại toàn bộ' : 'Chuẩn bị footage còn thiếu',
          mode: input.mode,
          priority: BATCH_PREP_PRIORITY,
          status: 'running',
          createdBy: input.requestedBy,
        }),
      );
      for (let i = 0; i < assetIds.length; i += INSERT_CHUNK) {
        const preps = assetIds.slice(i, i + INSERT_CHUNK).map((assetId) => ({
          id: uuidv7(),
          assetId,
          status: 'queued' as const,
          lane: 'batch' as const,
          priority: BATCH_PREP_PRIORITY,
          batchId: batch.id,
          requestedBy: input.requestedBy,
          transcriptStatus: 'pending' as const,
        }));
        await manager.insert(AssetPrepEntity, preps);
        await manager.save(
          preps.map((prep) =>
            this.outboxService.create(manager, {
              eventType: ASSET_PREP_REQUESTED_EVENT,
              aggregateType: 'asset_prep',
              aggregateId: prep.id,
              payload: { prepId: prep.id },
            }),
          ),
          { chunk: 100 },
        );
      }
      return batch.id;
    });
    await this.pipeline.log(
      'info',
      'prep.backfill',
      `Prep backfill (${input.mode}): ${assetIds.length} queued`,
      { batchId, mode: input.mode, count: assetIds.length, userId: input.requestedBy },
    );
    return { batchId, count: assetIds.length };
  }

  // ---------------------------------------------------------------------------
  // Batch controls
  // ---------------------------------------------------------------------------

  /** Stops the batch: its farm jobs are paused, and its next steps are held here. */
  async pause(id: string): Promise<PrepBatchView> {
    const batch = await this.requireBatch(id);
    if (batch.status === 'running') {
      await this.batchRepo.update(id, { status: 'paused' });
      await this.farmClient.controlJobs('pause', { group_key: prepBatchGroupKey(id) });
    }
    return this.get(id);
  }

  /**
   * Resumes the batch's farm jobs and sends what was held: preps never sent go back through the
   * outbox, and preps whose shots are in get their transcript job.
   */
  async resume(id: string): Promise<PrepBatchView> {
    const batch = await this.requireBatch(id);
    if (batch.status === 'paused') {
      await this.batchRepo.update(id, { status: 'running' });
      await this.farmClient.controlJobs('resume', { group_key: prepBatchGroupKey(id) });

      const unsent = await this.dataSource.query<{ id: string }[]>(
        `SELECT p.id FROM asset_preps p
         WHERE p.batch_id = $1 AND p.status = 'queued'
           AND NOT EXISTS (SELECT 1 FROM asset_prep_farm_jobs j WHERE j.prep_id = p.id)`,
        [id],
      );
      await this.dataSource.transaction(async (manager) => {
        for (let i = 0; i < unsent.length; i += INSERT_CHUNK) {
          await manager.save(
            unsent.slice(i, i + INSERT_CHUNK).map((prep) =>
              this.outboxService.create(manager, {
                eventType: ASSET_PREP_REQUESTED_EVENT,
                aggregateType: 'asset_prep',
                aggregateId: prep.id,
                payload: { prepId: prep.id },
              }),
            ),
            { chunk: 100 },
          );
        }
      });

      const held = await this.dataSource.query<{ id: string }[]>(
        `SELECT p.id FROM asset_preps p
         JOIN asset_prep_farm_jobs j ON j.prep_id = p.id AND j.type = $2 AND j.ingested_at IS NOT NULL
         WHERE p.batch_id = $1 AND p.status = 'cutting' AND p.transcript_status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM asset_prep_farm_jobs t WHERE t.prep_id = p.id AND t.type = $3)`,
        [id, PREP_JOB_TYPES.prep, PREP_JOB_TYPES.transcribe],
      );
      for (const prep of held) {
        try {
          await this.pipeline.advance(prep.id);
        } catch (error) {
          this.logger.warn(`Could not resume prep ${prep.id}: ${String(error)}`);
        }
      }
    }
    return this.get(id);
  }

  /** Cancels everything unfinished in the batch, at the farm and here. */
  async cancel(id: string): Promise<PrepBatchView> {
    const batch = await this.requireBatch(id);
    if (batch.status !== 'cancelled') {
      await this.batchRepo.update(id, { status: 'cancelled' });
      await this.farmClient.controlJobs('cancel', { group_key: prepBatchGroupKey(id) });
      await this.prepRepo
        .createQueryBuilder()
        .update(AssetPrepEntity)
        .set({ status: 'cancelled', error: 'Batch cancelled' })
        .where('batch_id = :id', { id })
        .andWhere('status IN (:...unfinished)', { unfinished: PREP_UNFINISHED_STATUSES })
        .execute();
    }
    return this.get(id);
  }

  async get(id: string): Promise<PrepBatchView> {
    const [view] = await this.views([await this.requireBatch(id)]);
    return view;
  }

  // ---------------------------------------------------------------------------

  private async requireBatch(id: string): Promise<AssetPrepBatchEntity> {
    const batch = await this.batchRepo.findOne({ where: { id } });
    if (!batch) throw new NotFoundException('Prep batch not found');
    return batch;
  }

  private async views(batches: AssetPrepBatchEntity[]): Promise<PrepBatchView[]> {
    if (batches.length === 0) return [];
    const rows = await this.prepRepo
      .createQueryBuilder('p')
      .select('p.batch_id', 'batchId')
      .addSelect('p.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where({ batchId: In(batches.map((b) => b.id)) })
      .groupBy('p.batch_id')
      .addGroupBy('p.status')
      .getRawMany<{ batchId: string; status: string; count: string }>();
    return batches.map((batch) => {
      let total = 0;
      let done = 0;
      let failed = 0;
      let unfinished = 0;
      for (const row of rows.filter((r) => r.batchId === batch.id)) {
        const n = Number(row.count);
        total += n;
        if (row.status === 'ready') done += n;
        else if (row.status === 'failed') failed += n;
        else if (row.status !== 'cancelled') unfinished += n;
      }
      const completed = batch.status === 'running' && total > 0 && unfinished === 0;
      return {
        id: batch.id,
        name: batch.name,
        mode: batch.mode,
        status: completed ? 'completed' : batch.status,
        total,
        done,
        failed,
        createdAt: batch.createdAt,
      };
    });
  }
}
