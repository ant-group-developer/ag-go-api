import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AnalysisBatchEntity } from '../../database/entities/analysis-batch.entity';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetPrepBatchEntity } from '../../database/entities/asset-prep-batch.entity';
import { AssetPrepFarmJobEntity } from '../../database/entities/asset-prep-farm-job.entity';
import { AssetPrepEntity } from '../../database/entities/asset-prep.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import { QueueModule } from '../../infra/queue/queue.module';
import { AccountModule } from '../account/account.module';
import { StorageModule } from '../assets/storage/storage.module';
import { LogsModule } from '../logs/logs.module';
import { AnalysisBatchService } from './analysis-batch.service';
import { AnalysisEnqueueService } from './analysis-enqueue.service';
import { AnalysisLogService } from './analysis-log.service';
import { AnalysisOutboxService } from './analysis-outbox.service';
import { AnalysisPipelineService } from './analysis-pipeline.service';
import { AnalysisSignService } from './analysis-sign.service';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { FarmResultPollerService } from './farm-result-poller.service';
import { FarmClient } from './farm/farm-client';
import { FarmTicketGuard } from './farm/farm-ticket.guard';
import { PrepIngestService } from './prep/prep-ingest.service';
import { PrepPipelineService } from './prep/prep-pipeline.service';
import { PrepSignService } from './prep/prep-sign.service';
import { PrepController } from './prep/prep.controller';
import { PrepService } from './prep/prep.service';

@Module({
  imports: [
    AccountModule,
    StorageModule,
    forwardRef(() => QueueModule),
    LogsModule,
    TypeOrmModule.forFeature([
      AssetAnalysisEntity,
      AnalysisBatchEntity,
      AnalysisFarmJobEntity,
      AssetPrepEntity,
      AssetPrepBatchEntity,
      AssetPrepFarmJobEntity,
      AssetEntity,
      AssetVariantEntity,
      ProjectEntity,
      ProjectMediaEntity,
      FolderClosureEntity,
      SystemLogEntity,
    ]),
  ],
  controllers: [AnalysisController, PrepController],
  providers: [
    AuthContextService,
    FarmClient,
    FarmTicketGuard,
    AnalysisBatchService,
    AnalysisEnqueueService,
    AnalysisLogService,
    AnalysisPipelineService,
    AnalysisOutboxService,
    AnalysisService,
    AnalysisSignService,
    FarmResultPollerService,
    PrepPipelineService,
    PrepIngestService,
    PrepSignService,
    PrepService,
  ],
  exports: [
    AnalysisEnqueueService,
    AnalysisOutboxService,
    FarmResultPollerService,
    PrepPipelineService,
  ],
})
export class AnalysisModule {}
