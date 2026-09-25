import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { TagEntity } from '../../database/entities/tag.entity';
import { QueueModule } from '../../infra/queue/queue.module';
import { AccountModule } from '../account/account.module';
import { AuditModule } from '../audit/audit.module';
import { FoldersModule } from '../folders/folders.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [
    AccountModule,
    AuditModule,
    FoldersModule,
    QueueModule,
    TypeOrmModule.forFeature([
      ProjectEntity,
      ProjectEvaluationSummaryEntity,
      FolderEntity,
      CategoryEntity,
      CountryEntity,
      ProvinceEntity,
      TagEntity,
    ]),
  ],
  controllers: [ProjectsController],
  providers: [AuthContextService, ProjectsService],
})
export class ProjectsModule {}
