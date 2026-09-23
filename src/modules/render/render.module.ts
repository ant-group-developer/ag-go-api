import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { MediaRenderJobEntity } from '../../database/entities/media-render-job.entity';
import { ProjectMediaEntity } from '../../database/entities/project-media.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { RenderBatchEntity } from '../../database/entities/render-batch.entity';
import { RenderProfileEntity } from '../../database/entities/render-profile.entity';
import { QueueModule } from '../../infra/queue/queue.module';
import { AccountModule } from '../account/account.module';
import { FoldersModule } from '../folders/folders.module';
import { RenderController } from './render.controller';
import { RenderService } from './render.service';

@Module({
  imports: [
    AccountModule,
    FoldersModule,
    QueueModule,
    TypeOrmModule.forFeature([
      RenderProfileEntity,
      RenderBatchEntity,
      MediaRenderJobEntity,
      ProjectEntity,
      ProjectMediaEntity,
    ]),
  ],
  controllers: [RenderController],
  providers: [AuthContextService, RenderService],
})
export class RenderModule {}
