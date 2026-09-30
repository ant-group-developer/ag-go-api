import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { AnalysisLogService } from './analysis-log.service';
import { FarmClient } from './farm/farm-client';
import { ScanExtractPayloadSchema } from './farm/scan';

/**
 * Handles the `asset.analysis.requested` outbox event branch.
 * Submits a scan.extract job to ag-farm and records the farm job id.
 */
@Injectable()
export class AnalysisOutboxService {
  private readonly logger = new Logger(AnalysisOutboxService.name);

  constructor(
    @InjectRepository(AssetAnalysisEntity)
    private readonly analysisRepo: Repository<AssetAnalysisEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepo: Repository<AssetEntity>,
    @InjectRepository(AnalysisFarmJobEntity)
    private readonly farmJobRepo: Repository<AnalysisFarmJobEntity>,
    private readonly farmClient: FarmClient,
    private readonly analysisLog: AnalysisLogService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Processes an `asset.analysis.requested` outbox event.
   * Submits a scan.extract job to ag-farm.
   * Throws on failure (so the outbox dispatcher can retry).
   */
  async handleAnalysisRequested(analysisId: string): Promise<void> {
    try {
      await this.submitExtract(analysisId);
    } catch (error) {
      await this.recordSubmitFailure(analysisId, error);
      throw error;
    }
  }

  private async submitExtract(analysisId: string): Promise<void> {
    if (!this.farmClient.isConfigured) {
      throw new Error('FARM_URL is not configured — cannot submit scan.extract job');
    }

    const analysis = await this.analysisRepo.findOne({ where: { id: analysisId } });
    if (!analysis) {
      throw new Error(`Analysis ${analysisId} not found`);
    }
    const asset = await this.assetRepo.findOne({ where: { id: analysis.assetId } });
    if (!asset) {
      throw new Error(`Asset ${analysis.assetId} not found`);
    }

    // Build the payload from asset metadata
    const sourceMetadata = asset.sourceMetadata as Record<string, unknown>;
    const durationMs =
      typeof sourceMetadata['durationSeconds'] === 'number'
        ? Math.round(sourceMetadata['durationSeconds'] * 1000)
        : null;
    const width = typeof sourceMetadata['width'] === 'number' ? sourceMetadata['width'] : null;
    const height = typeof sourceMetadata['height'] === 'number' ? sourceMetadata['height'] : null;

    const kind = asset.assetType === 'video' ? 'video' : 'image';

    const payload = ScanExtractPayloadSchema.parse({
      asset: {
        id: asset.id,
        kind,
        mime_type: asset.mimeType,
        size_bytes: Number(asset.fileSizeBytes) || null,
        checksum_sha256: asset.checksumSha256 ?? null,
        duration_ms: durationMs,
        width: width ?? null,
        height: height ?? null,
      },
      extract_version: analysis.extractVersion,
    });

    const correlationId = `${analysisId}:extract`;

    const response = await this.farmClient.submitJob({
      type: 'scan.extract',
      lane: 'batch',
      priority: analysis.priority,
      affinity_key: analysisId,
      payload,
      max_attempts: 3,
      correlation_id: correlationId,
    });

    // Record the farm job
    const farmJobEntity = this.farmJobRepo.create({
      farmJobId: response.job.id,
      analysisId,
      type: 'scan.extract',
      chunk: null,
      status: 'submitted',
    });
    await this.farmJobRepo.save(farmJobEntity);

    // Update analysis status to extracting; a submit error kept by an earlier attempt is over
    await this.analysisRepo.update(analysisId, { status: 'extracting', reason: null });

    this.logger.log(
      `Submitted scan.extract job ${response.job.id} for analysis ${analysisId} (asset ${asset.id})`,
    );
    await this.analysisLog.write({
      level: 'info',
      action: 'analysis.extract.submitted',
      message: `Sent ${asset.originalFilename} to the farm for extraction`,
      metadata: { analysisId, assetId: asset.id, farmJobId: response.job.id },
    });
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
