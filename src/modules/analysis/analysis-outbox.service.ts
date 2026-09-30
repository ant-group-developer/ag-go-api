import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';

/**
 * Handles the `asset.analysis.requested` outbox event: sends the analysis to the farm
 * (scan.extract), unless its batch is paused or cancelled.
 */
@Injectable()
export class AnalysisOutboxService {
  private readonly logger = new Logger(AnalysisOutboxService.name);

  constructor(
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    private readonly pipeline: AnalysisPipelineService,
    private readonly analysisLog: AnalysisLogService,
  ) {}

  /** Throws on failure so the outbox dispatcher retries. */
  async handleAnalysisRequested(analysisId: string): Promise<void> {
    try {
      await this.pipeline.submitExtract(analysisId);
    } catch (error) {
      await this.recordSubmitFailure(analysisId, error);
      throw error;
    }
  }

  /**
   * Keeps the submit error on the queued analysis and logs it. The outbox retries with backoff
   * for about a day, so only a new error text is logged, not every retry of the same one.
   */
  private async recordSubmitFailure(analysisId: string, error: unknown): Promise<void> {
    const reason = `Could not submit to the farm: ${error instanceof Error ? error.message : String(error)}`;
    try {
      const analysis = await this.analysisRepo.findOne({ where: { id: analysisId } });
      if (!analysis || analysis.status !== 'queued' || analysis.reason === reason) return;
      await this.analysisRepo.update(analysisId, { reason });
      const asset = await this.assetRepo.findOne({ where: { id: analysis.assetId } });
      await this.analysisLog.write({
        level: 'warn',
        action: 'analysis.extract.submit_failed',
        message: `${asset?.originalFilename ?? analysis.assetId}: ${reason} (retrying)`,
        metadata: { analysisId, assetId: analysis.assetId },
      });
    } catch (recordError) {
      // The outbox still retries and logs the original error; this is only the web-visible copy.
      this.logger.warn(
        `Could not record submit failure of analysis ${analysisId}: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
      );
    }
  }
}
