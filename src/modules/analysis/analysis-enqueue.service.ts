import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { OutboxService } from '../../common/outbox.service';
import {
  AssetAnalysisEntity,
  IN_FLIGHT_STATUSES,
} from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { autoBatchId } from './analysis-batches';

/**
 * Enqueues a media-analysis run for an asset inside an existing transaction.
 * Called from MediaProcessingService when an asset becomes ready, and from the
 * manual POST /assets/:assetId/analysis endpoint.
 */
@Injectable()
export class AnalysisEnqueueService {
  private readonly logger = new Logger(AnalysisEnqueueService.name);

  constructor(
    private readonly outboxService: OutboxService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Enqueues analysis for the given asset inside `manager`'s transaction.
   * Returns the new analysis id, or null if skipped (in-flight or current same version).
   * `skipIfCurrent` = true (default) skips when a current analysis with the same versions
   * already exists — used in the auto-enqueue path to ignore watermark re-renders.
   */
  async enqueueInsideTransaction(
    manager: EntityManager,
    asset: Pick<AssetEntity, 'id'>,
    options: {
      requestedBy?: string | null;
      priority?: number;
      skipIfCurrent?: boolean;
      skipIfInFlight?: boolean;
      /** Scan batch; defaults to the automatic batch. */
      batchId?: string;
    } = {},
  ): Promise<string | null> {
    const {
      requestedBy = null,
      priority = 0,
      skipIfCurrent = true,
      skipIfInFlight = true,
    } = options;

    const extractVersion = this.config.get<string>('ANALYSIS_EXTRACT_VERSION') ?? 'x2';
    const promptVersion = this.config.get<string>('ANALYSIS_PROMPT_VERSION') ?? 'p2';

    if (skipIfInFlight) {
      const inFlight = await manager.findOne(AssetAnalysisEntity, {
        where: IN_FLIGHT_STATUSES.map((s) => ({ assetId: asset.id, status: s })) as Parameters<
          typeof manager.findOne
        >[1]['where'],
      });
      if (inFlight) {
        this.logger.debug(
          `Skipping enqueue for asset ${asset.id}: analysis ${inFlight.id} is in flight (${inFlight.status})`,
        );
        return null;
      }
    }

    if (skipIfCurrent) {
      const current = await manager.findOne(AssetAnalysisEntity, {
        where: {
          assetId: asset.id,
          isCurrent: true,
          extractVersion,
          promptVersion,
        },
      });
      if (current) {
        this.logger.debug(
          `Skipping enqueue for asset ${asset.id}: current analysis ${current.id} already at versions extract=${extractVersion} prompt=${promptVersion}`,
        );
        return null;
      }
    }

    const analysisId = uuidv7();
    const analysis = manager.create(AssetAnalysisEntity, {
      id: analysisId,
      assetId: asset.id,
      status: 'queued',
      priority,
      extractVersion,
      promptVersion,
      isCurrent: false,
      requestedBy,
      batchId: options.batchId ?? (await autoBatchId(manager)),
    });
    await manager.save(AssetAnalysisEntity, analysis);

    const outboxEvent = this.outboxService.create(manager, {
      eventType: 'asset.analysis.requested',
      aggregateType: 'asset_analysis',
      aggregateId: analysisId,
      payload: { analysisId },
    });
    await manager.save(outboxEvent);

    this.logger.log(`Enqueued analysis ${analysisId} for asset ${asset.id}`);
    return analysisId;
  }

  /**
   * Checks whether ANALYSIS_AUTO_ENQUEUE is enabled.
   * Called from MediaProcessingService to decide whether to auto-enqueue.
   */
  isAutoEnqueueEnabled(): boolean {
    return this.config.get<boolean>('ANALYSIS_AUTO_ENQUEUE') === true;
  }
}
