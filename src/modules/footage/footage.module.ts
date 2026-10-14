import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetAnalysisEntity } from '../../database/entities/asset-analysis.entity';
import { AssetVariantEntity } from '../../database/entities/asset-variant.entity';
import { AssetEntity } from '../../database/entities/asset.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { AccountModule } from '../account/account.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { StorageModule } from '../assets/storage/storage.module';
import { FoldersModule } from '../folders/folders.module';
import { LogsModule } from '../logs/logs.module';
import { FootageScopeService } from './footage-scope.service';
import { FootageController } from './footage.controller';
import { FootageService } from './footage.service';

@Module({
  imports: [
    AccountModule,
    AnalysisModule,
    FoldersModule,
    StorageModule,
    LogsModule,
    TypeOrmModule.forFeature([
      AssetEntity,
      AssetVariantEntity,
      AssetAnalysisEntity,
      FolderEntity,
      ProjectEntity,
      ProjectMediaEntity,
      RenderProfileEntity,
    ]),
  ],
  controllers: [FootageController],
  providers: [AuthContextService, FootageScopeService, FootageService],
  exports: [FootageScopeService],
})
export class FootageModule {}
