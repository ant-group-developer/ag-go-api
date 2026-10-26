import { Module } from '@nestjs/common';
import { AuthContextService } from '../../common/auth-context.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SystemLogEntity } from '../../database/entities/system-log.entity';
import { AccountModule } from '../account/account.module';
import { FoldersModule } from '../folders/folders.module';
import { LogsController } from './logs.controller';
import { LogsService } from './logs.service';
import { SystemLogService } from './system-log.service';
import { UploadSpeedService } from './upload-speed.service';

@Module({
  imports: [AccountModule, FoldersModule, TypeOrmModule.forFeature([SystemLogEntity])],
  controllers: [LogsController],
  providers: [AuthContextService, LogsService, SystemLogService, UploadSpeedService],
  exports: [SystemLogService],
})
export class LogsModule {}
