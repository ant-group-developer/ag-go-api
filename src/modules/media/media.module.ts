import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetEntity } from '../../database/entities/asset.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectMediaEvaluationEntity } from '../../database/entities/project-media-evaluation.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { AccountModule } from '../account/account.module';
import { AuditModule } from '../audit/audit.module';
import { FoldersModule } from '../folders/folders.module';
import { StorageModule } from '../assets/storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [
    AccountModule,
    AuditModule,
    FoldersModule,
    StorageModule,
    TypeOrmModule.forFeature([
      AssetEntity,
      ProjectEntity,
      ProjectEvaluationSummaryEntity,
      ProjectMediaEntity,
      ProjectMediaEvaluationEntity,
    ]),
  ],
  controllers: [MediaController],
  providers: [AuthContextService, MediaService],
})
export class MediaModule {}
