import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { DownloadJobItemEntity } from '../../database/entities/download-job-item.entity';
import { DownloadJobEntity } from '../../database/entities/download-job.entity';
import { DownloadLogEntity } from '../../database/entities/download-log.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { QueueModule } from '../../infra/queue/queue.module';
import { AccountModule } from '../account/account.module';
import { StorageModule } from '../assets/storage/storage.module';
import { FoldersModule } from '../folders/folders.module';
import { DownloadWorkerService } from './download-worker.service';
import { DownloadsController } from './downloads.controller';
import { DownloadsService } from './downloads.service';

@Module({
  imports: [
    AccountModule,
    FoldersModule,
    StorageModule,
    QueueModule,
    TypeOrmModule.forFeature([
      DownloadJobEntity,
      DownloadJobItemEntity,
      DownloadLogEntity,
      ProjectMediaEntity,
      ProjectEntity,
      AssetEntity,
      AssetVariantEntity,
      RenderProfileEntity,
    ]),
  ],
  controllers: [DownloadsController],
  providers: [AuthContextService, DownloadsService, DownloadWorkerService],
})
export class DownloadsModule {}
