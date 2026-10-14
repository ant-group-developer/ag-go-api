import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { ProjectEntity } from '../../database/entities/project.entity';
import { AccountModule } from '../account/account.module';
import { FoldersModule } from '../folders/folders.module';
import { FootageModule } from '../footage/footage.module';
import { StudioUsageController } from './studio-usage.controller';
import { StudioUsageService } from './studio-usage.service';

/** How AG Studio uses ag-go footage: events in, usage counts out. */
@Module({
  imports: [AccountModule, FoldersModule, FootageModule, TypeOrmModule.forFeature([ProjectEntity])],
  controllers: [StudioUsageController],
  providers: [AuthContextService, StudioUsageService],
  exports: [StudioUsageService],
})
export class UsageModule {}
