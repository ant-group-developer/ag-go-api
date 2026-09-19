import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { CategoryEntity } from '../../database/entities/category.entity';
import { CountryEntity } from '../../database/entities/country.entity';
import { FolderEntity } from '../../database/entities/folder.entity';
import { ProjectEvaluationSummaryEntity } from '../../database/entities/project-evaluation-summary.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { ProvinceEntity } from '../../database/entities/province.entity';
import { FoldersModule } from '../folders/folders.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [
    FoldersModule,
    TypeOrmModule.forFeature([
      ProjectEntity,
      ProjectEvaluationSummaryEntity,
      FolderEntity,
      CategoryEntity,
      CountryEntity,
      ProvinceEntity,
    ]),
  ],
  controllers: [ProjectsController],
  providers: [AuthContextService, ProjectsService],
})
export class ProjectsModule {}
