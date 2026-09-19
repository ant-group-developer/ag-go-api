import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetUploadSessionEntity } from '../../database/entities/asset-upload-session.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { FoldersModule } from '../folders/folders.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { MediaProcessingService } from './media-processing.service';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    FoldersModule,
    StorageModule,
    TypeOrmModule.forFeature([
      AssetEntity,
      AssetUploadSessionEntity,
      AssetVariantEntity,
      MediaRenderJobEntity,
      ProjectMediaEntity,
      ProjectEntity,
    ]),
  ],
  controllers: [AssetsController],
  providers: [AuthContextService, AssetsService, MediaProcessingService],
})
export class AssetsModule {}
