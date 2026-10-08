import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { CategoryEntity } from '../../database/entities/category.entity';
import { ProjectEntity } from '../../database/entities/project.entity';
import { AccountModule } from '../account/account.module';
import { FoldersModule } from '../folders/folders.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  imports: [
    AccountModule,
    FoldersModule,
    TypeOrmModule.forFeature([CategoryEntity, ProjectEntity]),
  ],
  controllers: [CategoriesController],
  providers: [AuthContextService, CategoriesService],
})
export class CategoriesModule {}
