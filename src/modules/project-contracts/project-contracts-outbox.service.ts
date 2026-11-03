import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { IN_FLIGHT_STATUSES } from '../../database/entities/asset-analysis.entity';
import { AnalysisEnqueueService } from '../analysis/analysis-enqueue.service';
import { SpecChecksService } from './spec-checks.service';

/**
 * Outbox consumers of the contract checks: `project.spec_checks.requested` (a project was linked or
 * delivered under a contract) and `asset.analysis.completed` (an analysis became current). Both
 * throw on failure so the dispatcher retries.
 */
@Injectable()
export class ProjectContractsOutboxService {
  private readonly logger = new Logger(ProjectContractsOutboxService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly specChecks: SpecChecksService,
    private readonly analysisEnqueue: AnalysisEnqueueService,
  ) {}

  /**
   * Queues the analyses its videos still miss (FR-T-01) when automatic analysis is on, then checks
   * the project. Videos left without analysis stay `unknown` until one completes.
   */
  async handleSpecChecksRequested(projectId: string): Promise<void> {
    if (this.analysisEnqueue.isAutoEnqueueEnabled()) {
      const queued = await this.dataSource.transaction((manager) =>
        this.enqueueMissingAnalyses(manager, projectId, null),
      );
      if (queued > 0) {
        this.logger.log(`Queued ${queued} analysis(es) for the checks of project ${projectId}`);
      }
    }
    await this.specChecks.refreshProject(projectId);
  }

  async handleAnalysisCompleted(assetId: string): Promise<void> {
    await this.specChecks.refreshAsset(assetId);
  }

  /**
   * Queues an analysis for each ready video of the project with neither a current analysis nor one
   * in flight. Returns how many were queued.
   */
  async enqueueMissingAnalyses(
    manager: EntityManager,
    projectId: string,
    requestedBy: string | null,
  ): Promise<number> {
    const rows = (await manager.query(
      `SELECT DISTINCT asset.id
       FROM project_media media
       INNER JOIN assets asset ON asset.id = media.asset_id
       WHERE media.project_id = $1
         AND asset.asset_type = 'video'
         AND asset.processing_status = 'ready'
         AND NOT EXISTS (
           SELECT 1 FROM asset_analyses analysis
           WHERE analysis.asset_id = asset.id
             AND (analysis.is_current = true OR analysis.status = ANY($2::varchar[]))
         )`,
      [projectId, IN_FLIGHT_STATUSES],
    )) as Array<{ id: string }>;
    let queued = 0;
    for (const row of rows) {
      const id = await this.analysisEnqueue.enqueueInsideTransaction(manager, row, {
        requestedBy,
        skipIfCurrent: false,
      });
      if (id) {
        queued += 1;
      }
    }
    return queued;
  }
}
