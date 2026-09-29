import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AnalysisFarmJobEntity } from '../../database/entities/analysis-farm-job.entity';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { MediaSegmentEntity } from '../../database/entities/media-segment.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { QueueModule } from '../../infra/queue/queue.module';
import { StorageModule } from '../assets/storage/storage.module';
import { LogsModule } from '../logs/logs.module';
import { AnalysisEnqueueService } from './analysis-enqueue.service';
import { AnalysisOutboxService } from './analysis-outbox.service';
import { AnalysisSignService } from './analysis-sign.service';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { FarmResultPollerService } from './farm-result-poller.service';
import { FarmClient } from './farm/farm-client';
import { FarmTicketGuard } from './farm/farm-ticket.guard';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => QueueModule),
    LogsModule,
    TypeOrmModule.forFeature([
      AssetAnalysisEntity,
      MediaSegmentEntity,
      AnalysisFarmJobEntity,
      AssetEntity,
      ProjectEntity,
      ProjectMediaEntity,
      FolderClosureEntity,
    ]),
  ],
  controllers: [AnalysisController],
  providers: [
    AuthContextService,
    FarmClient,
    FarmTicketGuard,
    AnalysisEnqueueService,
    AnalysisOutboxService,
    AnalysisService,
    AnalysisSignService,
    FarmResultPollerService,
  ],
  exports: [AnalysisEnqueueService, AnalysisOutboxService, FarmResultPollerService],
})
export class AnalysisModule {}
