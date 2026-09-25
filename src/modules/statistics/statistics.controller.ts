import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { StatisticsQueryDto } from './dto/statistics-query.dto';
import { StatisticsService } from './statistics.service';

@ApiTags('statistics')
@ApiBearerAuth()
@Controller('statistics')
export class StatisticsController {
  constructor(
    private readonly statisticsService: StatisticsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('overview')
  @RequirePermissions(GO_PERMISSIONS.STATISTICS_READ)
  overview(@Req() request: Request, @Query() query: StatisticsQueryDto) {
    const context = this.authContext.getContext(request);
    return this.statisticsService.overview(context.userId, context.userType, query);
  }

  @Get('rendering')
  @RequirePermissions(GO_PERMISSIONS.STATISTICS_READ)
  rendering(@Req() request: Request, @Query() query: StatisticsQueryDto) {
    const context = this.authContext.getContext(request);
    return this.statisticsService.rendering(context.userId, context.userType, query);
  }
}
