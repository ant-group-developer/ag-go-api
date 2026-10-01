import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderAccessGrantEntity } from '../../database/entities/folder-access-grant.entity';
import { FolderClosureEntity } from '../../database/entities/folder-closure.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { StorageModule } from '../assets/storage/storage.module';
import { FolderAccessService } from '../folders/folder-access.service';
import { LogsModule } from '../logs/logs.module';
import { FootageScopeService } from './footage-scope.service';
import { FootageController } from './footage.controller';
import { FootageService } from './footage.service';

@Module({
  imports: [
    StorageModule,
    LogsModule,
    TypeOrmModule.forFeature([
      AssetEntity,
      AssetVariantEntity,
      AssetAnalysisEntity,
      FolderEntity,
      FolderClosureEntity,
      FolderAccessGrantEntity,
      ProjectEntity,
      ProjectMediaEntity,
      RenderProfileEntity,
    ]),
  ],
  controllers: [FootageController],
  providers: [AuthContextService, FolderAccessService, FootageScopeService, FootageService],
})
export class FootageModule {}
