import { Module } from '@nestjs/common';
import { AuthContextService } from '../../common/auth-context.service';
import { FoldersModule } from '../folders/folders.module';
import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';

@Module({
  imports: [FoldersModule],
  controllers: [StatisticsController],
  providers: [AuthContextService, StatisticsService],
})
export class StatisticsModule {}
