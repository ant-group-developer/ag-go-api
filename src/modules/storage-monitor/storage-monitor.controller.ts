import { Controller, Get, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { AdminOnly } from '../../common/auth/permissions.decorator';
import { StorageAuditService } from './storage-audit.service';
import { StorageMonitorService } from './storage-monitor.service';

@ApiTags('system')
@ApiBearerAuth()
@Controller('system/storage')
export class StorageMonitorController {
  constructor(
    private readonly authContext: AuthContextService,
    private readonly monitor: StorageMonitorService,
    private readonly audits: StorageAuditService,
  ) {}

  @Get()
  @AdminOnly()
  @ApiOperation({
    summary: 'R2 bucket size against the bytes the database knows of, with alerts (admins only)',
  })
  overview() {
    return this.monitor.overview();
  }

  @Post('audits')
  @AdminOnly()
  @ApiOperation({
    summary: 'Queue a full bucket audit, or return the one already queued or running (admins only)',
  })
  requestAudit(@Req() request: Request) {
    return this.audits.request(this.authContext.getContext(request).userId);
  }
}
