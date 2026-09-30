import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetUploadSessionEntity } from '../../database/entities/asset-upload-session.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { QueueModule } from '../../infra/queue/queue.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { AuditModule } from '../audit/audit.module';
import { FoldersModule } from '../folders/folders.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { MediaProcessingService } from './media-processing.service';
import { MediaQueueWorkerService } from './media-queue-worker.service';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    AuditModule,
    FoldersModule,
    StorageModule,
    QueueModule,
    forwardRef(() => AnalysisModule),
    TypeOrmModule.forFeature([
      AssetEntity,
      AssetUploadSessionEntity,
      AssetVariantEntity,
      MediaRenderJobEntity,
      RenderBatchEntity,
      RenderProfileEntity,
      ProjectMediaEntity,
      ProjectEntity,
    ]),
  ],
  controllers: [AssetsController],
  providers: [AuthContextService, AssetsService, MediaProcessingService, MediaQueueWorkerService],
  exports: [AssetsService],
})
export class AssetsModule {}
