import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { AdminOnly, RequirePermissions } from '../../common/auth/permissions.decorator';
import { LogsQueryDto } from './dto/logs-query.dto';
import { UploadSpeedQueryDto } from './dto/upload-speed-query.dto';
import { LogsService } from './logs.service';
import { UploadSpeedService } from './upload-speed.service';

@ApiTags('logs')
@ApiBearerAuth()
@Controller('logs')
export class LogsController {
  constructor(
    private readonly logs: LogsService,
    private readonly uploadSpeed: UploadSpeedService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get()
  @RequirePermissions(GO_PERMISSIONS.LOGS_READ)
  list(@Query() query: LogsQueryDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.logs.list(query, context.userId, context.userType);
  }

  @Get('upload-speed/filters')
  @AdminOnly()
  @ApiOperation({ summary: 'Projects and uploaders found in the upload speed log (admins only)' })
  uploadSpeedFilters() {
    return this.uploadSpeed.filterOptions();
  }

  @Get('upload-speed')
  @AdminOnly()
  @ApiOperation({
    summary: 'Uploads with their transfer speed, failed and expired ones included (admins only)',
  })
  listUploadSpeed(@Query() query: UploadSpeedQueryDto) {
    return this.uploadSpeed.list(query);
  }
}
