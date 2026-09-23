import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { LogsQueryDto } from './dto/logs-query.dto';
import { LogsService } from './logs.service';

@ApiTags('logs')
@ApiBearerAuth()
@Controller('logs')
export class LogsController {
  constructor(
    private readonly logs: LogsService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  @RequirePermissions(GO_PERMISSIONS.LOGS_READ)
  list(@Query() query: LogsQueryDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.logs.list(query, context.userId, context.userType);
  }
}
