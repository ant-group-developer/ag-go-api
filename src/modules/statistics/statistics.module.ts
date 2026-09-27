import { Module } from '@nestjs/common';
import { AccountModule } from '../account/account.module';
import { FoldersModule } from '../folders/folders.module';
import { StatisticsActivityService } from './statistics-activity.service';
import { StatisticsOperationsService } from './statistics-operations.service';
import { StatisticsProgressService } from './statistics-progress.service';
import { StatisticsScopeService } from './statistics-scope.service';
import { StatisticsSummaryService } from './statistics-summary.service';
import { StatisticsTeamService } from './statistics-team.service';
import { StatisticsTrendService } from './statistics-trend.service';
import { StatisticsController } from './statistics.controller';

@Module({
  imports: [AccountModule, FoldersModule],
  controllers: [StatisticsController],
  providers: [
    StatisticsScopeService,
    StatisticsSummaryService,
    StatisticsTrendService,
    StatisticsProgressService,
    StatisticsTeamService,
    StatisticsOperationsService,
    StatisticsActivityService,
  ],
})
export class StatisticsModule {}
