import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  AnalysisBatchEntity,
  type AnalysisBatchKind,
} from '../../database/entities/analysis-batch.entity';
import {
  AssetAnalysisEntity,
  FINISHED_STATUSES,
} from '../../database/entities/asset-analysis.entity';
import { batchGroupKey } from './analysis-batches';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';
import { FarmClient } from './farm/farm-client';

export type AnalysisBatchCounts = {
  total: number;
  /** Waiting to be sent, including paused analyses. */
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
};

export type AnalysisBatchView = {
  id: string;
  name: string;
  kind: AnalysisBatchKind;
  mode: string | null;
  scope: { folderIds: string[]; projectIds: string[] };
  priority: number;
  status: 'running' | 'paused' | 'cancelled' | 'completed';
  counts: AnalysisBatchCounts;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type BatchSortField = 'createdAt' | 'name' | 'status';

const EMPTY_COUNTS: AnalysisBatchCounts = {
  total: 0,
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
};

/**
 * Scan batches: listing with progress, and pause / resume / cancel of a whole batch at once
 * (the farm acts on the batch's group key; analyses are parked or resumed here).
 */
@Injectable()
export class AnalysisBatchService {
  private readonly logger = new Logger(AnalysisBatchService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(AnalysisBatchEntity)
    private readonly batchRepo: Repository<AnalysisBatchEntity>,
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    private readonly pipeline: AnalysisPipelineService,
    private readonly farmClient: FarmClient,
    private readonly analysisLog: AnalysisLogService,
  ) {}

  /** A backfill batch, created in the caller's transaction before its analyses. */
  async createBackfillBatch(
    manager: EntityManager,
    input: {
      name: string;
      mode: string;
      folderIds?: string[];
      projectIds?: string[];
      priority: number;
      createdBy: string | null;
    },
  ): Promise<AnalysisBatchEntity> {
    return manager.save(
      manager.create(AnalysisBatchEntity, {
        name: input.name,
        kind: 'backfill',
        mode: input.mode,
        scope: { folderIds: input.folderIds ?? [], projectIds: input.projectIds ?? [] },
        priority: input.priority,
        status: 'running',
        createdBy: input.createdBy,
      }),
    );
  }

  async list(query: {
    page: number;
    pageSize: number;
    sortBy: BatchSortField;
    sortOrder: 'asc' | 'desc';
    status?: string;
  }): Promise<{ items: AnalysisBatchView[]; total: number; page: number; pageSize: number }> {
    const column = { createdAt: 'b.created_at', name: 'b.name', status: 'b.status' }[query.sortBy];
    const qb = this.batchRepo.createQueryBuilder('b');
    // `completed` is derived (same rule as toView): a running backfill with analyses, none unfinished
    const done = `(b.kind <> 'auto'
      AND EXISTS (SELECT 1 FROM asset_analyses a WHERE a.batch_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM asset_analyses a WHERE a.batch_id = b.id
                        AND a.status NOT IN ('completed','failed','cancelled')))`;
    if (query.status === 'completed') qb.where(`b.status = 'running' AND ${done}`);
    else if (query.status === 'running') qb.where(`b.status = 'running' AND NOT ${done}`);
    else if (query.status) qb.where('b.status = :status', { status: query.status });
    const [rows, total] = await qb
      .orderBy(column, query.sortOrder === 'asc' ? 'ASC' : 'DESC')
      .addOrderBy('b.created_at', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize)
      .getManyAndCount();
    const counts = await this.countsFor(rows.map((row) => row.id));
    const items = rows.map((row) => this.toView(row, counts.get(row.id) ?? EMPTY_COUNTS));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<AnalysisBatchView> {
    const batch = await this.batchRepo.findOne({ where: { id } });
    if (!batch) throw new NotFoundException('Batch not found');
    const counts = await this.countsFor([id]);
    return this.toView(batch, counts.get(id) ?? EMPTY_COUNTS);
  }

  /** Stops new work of the batch: its farm jobs are paused and its unfinished analyses parked. */
  async pause(id: string, userId: string | null): Promise<AnalysisBatchView> {
    const batch = await this.requireBatch(id);
    if (batch.status === 'running') {
      await this.batchRepo.update(id, { status: 'paused' });
      await this.farmClient.controlJobs('pause', { group_key: batchGroupKey(id) });
      await this.analysisRepo
        .createQueryBuilder()
        .update(AssetAnalysisEntity)
        .set({ status: 'paused' })
        .where('batch_id = :id', { id })
        .andWhere(`status IN ('queued','extracting','extracted','describing')`)
        .execute();
      await this.log('analysis.batch.paused', `Paused batch "${batch.name}"`, batch, userId);
    }
    return this.get(id);
  }

  /** Resumes the batch's farm jobs and sends whatever step of its paused analyses was never sent. */
  async resume(id: string, userId: string | null): Promise<AnalysisBatchView> {
    const batch = await this.requireBatch(id);
    if (batch.status === 'paused') {
      await this.batchRepo.update(id, { status: 'running' });
      await this.farmClient.controlJobs('resume', { group_key: batchGroupKey(id) });
      const paused = await this.analysisRepo.find({
        where: { batchId: id, status: 'paused' },
        select: { id: true },
        order: { priority: 'DESC', createdAt: 'ASC' },
      });
      for (const analysis of paused) {
        try {
          // The farm already resumed the whole group; only unsent steps are submitted here.
          await this.pipeline.resume(analysis.id, { farm: false });
        } catch (error) {
          this.logger.warn(`Could not resume analysis ${analysis.id}: ${String(error)}`);
        }
      }
      await this.log('analysis.batch.resumed', `Resumed batch "${batch.name}"`, batch, userId);
    }
    return this.get(id);
  }

  /**
   * Cancels everything unfinished in the batch. The automatic batch stays open for new uploads;
   * only its current work is cancelled.
   */
  async cancel(id: string, userId: string | null): Promise<AnalysisBatchView> {
    const batch = await this.requireBatch(id);
    if (batch.status !== 'cancelled') {
      if (batch.kind !== 'auto') await this.batchRepo.update(id, { status: 'cancelled' });
      else if (batch.status === 'paused') await this.batchRepo.update(id, { status: 'running' });
      await this.farmClient.controlJobs('cancel', { group_key: batchGroupKey(id) });
      await this.analysisRepo
        .createQueryBuilder()
        .update(AssetAnalysisEntity)
        .set({ status: 'cancelled', reason: 'Batch cancelled' })
        .where('batch_id = :id', { id })
        .andWhere('status NOT IN (:...finished)', { finished: FINISHED_STATUSES })
        .execute();
      await this.log('analysis.batch.cancelled', `Cancelled batch "${batch.name}"`, batch, userId);
    }
    return this.get(id);
  }

  // ---------------------------------------------------------------------------

  private async requireBatch(id: string): Promise<AnalysisBatchEntity> {
    const batch = await this.batchRepo.findOne({ where: { id } });
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  private async countsFor(batchIds: string[]): Promise<Map<string, AnalysisBatchCounts>> {
    const result = new Map<string, AnalysisBatchCounts>();
    if (batchIds.length === 0) return result;
    const rows = await this.analysisRepo
      .createQueryBuilder('a')
      .select('a.batch_id', 'batchId')
      .addSelect('a.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where({ batchId: In(batchIds) })
      .groupBy('a.batch_id')
      .addGroupBy('a.status')
      .getRawMany<{ batchId: string; status: string; count: string }>();
    for (const row of rows) {
      const counts = result.get(row.batchId) ?? { ...EMPTY_COUNTS };
      const n = Number(row.count);
      counts.total += n;
      if (row.status === 'queued' || row.status === 'paused') counts.queued += n;
      else if (row.status === 'completed') counts.completed += n;
      else if (row.status === 'failed') counts.failed += n;
      else if (row.status === 'cancelled') counts.cancelled += n;
      else counts.running += n;
      result.set(row.batchId, counts);
    }
    return result;
  }

  private toView(batch: AnalysisBatchEntity, counts: AnalysisBatchCounts): AnalysisBatchView {
    const done =
      batch.status === 'running' && counts.total > 0 && counts.queued + counts.running === 0;
    return {
      id: batch.id,
      name: batch.name,
      kind: batch.kind,
      mode: batch.mode,
      scope: { folderIds: batch.scope?.folderIds ?? [], projectIds: batch.scope?.projectIds ?? [] },
      priority: batch.priority,
      // The automatic batch never completes: new uploads keep joining it.
      status: done && batch.kind !== 'auto' ? 'completed' : batch.status,
      counts,
      createdBy: batch.createdBy,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    };
  }

  private async log(
    action: string,
    message: string,
    batch: AnalysisBatchEntity,
    userId: string | null,
  ): Promise<void> {
    await this.analysisLog.write({
      level: 'info',
      action,
      message,
      userId,
      metadata: { batchId: batch.id, kind: batch.kind },
    });
  }
}
