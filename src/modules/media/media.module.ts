import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { AssetEntity } from '../../database/entities/asset.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { FoldersModule } from '../folders/folders.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [
    FoldersModule,
    TypeOrmModule.forFeature([
      AssetEntity,
      ProjectEntity,
      ProjectEvaluationSummaryEntity,
      ProjectMediaEntity,
    ]),
  ],
  controllers: [MediaController],
  providers: [AuthContextService, MediaService],
})
export class MediaModule {}
