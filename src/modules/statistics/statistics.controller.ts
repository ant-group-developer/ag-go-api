import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { StatisticsBreakdownQueryDto } from './dto/statistics-breakdown-query.dto';
import { StatisticsLimitQueryDto } from './dto/statistics-limit-query.dto';
import { StatisticsPeriodQueryDto } from './dto/statistics-period-query.dto';
import { StatisticsActivityService } from './statistics-activity.service';
import { StatisticsBreakdownService } from './statistics-breakdown.service';
import { StatisticsOperationsService } from './statistics-operations.service';
import { StatisticsProgressService } from './statistics-progress.service';
import { StatisticsProjectTrendService } from './statistics-project-trend.service';
import { StatisticsSummaryService } from './statistics-summary.service';
import { StatisticsTeamService } from './statistics-team.service';
import { StatisticsTrendService } from './statistics-trend.service';

/** One endpoint per widget of the statistics page, all scoped to the caller's folders. */
@ApiTags('statistics')
@ApiBearerAuth()
@Controller('statistics')
@RequirePermissions(GO_PERMISSIONS.STATISTICS_READ)
export class StatisticsController {
  constructor(
    private readonly authContext: AuthContextService,
    private readonly summaryService: StatisticsSummaryService,
    private readonly trendService: StatisticsTrendService,
    private readonly progressService: StatisticsProgressService,
    private readonly teamService: StatisticsTeamService,
    private readonly operationsService: StatisticsOperationsService,
    private readonly activityService: StatisticsActivityService,
    private readonly projectTrendService: StatisticsProjectTrendService,
    private readonly breakdownService: StatisticsBreakdownService,
  ) {}

  @Get('summary')
  summary(@Req() request: Request, @Query() query: StatisticsPeriodQueryDto) {
    return this.summaryService.summary(this.authContext.getContext(request), query);
  }

  @Get('trend')
  trend(@Req() request: Request, @Query() query: StatisticsPeriodQueryDto) {
    return this.trendService.trend(this.authContext.getContext(request), query);
  }

  @Get('project-trend')
  projectTrend(@Req() request: Request, @Query() query: StatisticsPeriodQueryDto) {
    return this.projectTrendService.projectTrend(this.authContext.getContext(request), query);
  }

  /** Projects and media grouped by category, country, tag, resolution or file extension. */
  @Get('breakdown')
  breakdown(@Req() request: Request, @Query() query: StatisticsBreakdownQueryDto) {
    return this.breakdownService.breakdown(this.authContext.getContext(request), query);
  }

  @Get('progress')
  progress(@Req() request: Request, @Query() query: StatisticsLimitQueryDto) {
    return this.progressService.progress(this.authContext.getContext(request), query);
  }

  @Get('team')
  team(@Req() request: Request, @Query() query: StatisticsPeriodQueryDto) {
    return this.teamService.team(this.authContext.getContext(request), query);
  }

  @Get('operations')
  operations(@Req() request: Request, @Query() query: StatisticsPeriodQueryDto) {
    return this.operationsService.operations(this.authContext.getContext(request), query);
  }

  /** Cross-project audit entries: also needs audit access, like `GET /audit/project/:id`. */
  @Get('activity')
  @RequirePermissions(GO_PERMISSIONS.STATISTICS_READ, GO_PERMISSIONS.AUDIT_READ)
  activity(@Req() request: Request, @Query() query: StatisticsLimitQueryDto) {
    return this.activityService.activity(this.authContext.getContext(request), query);
  }
}
