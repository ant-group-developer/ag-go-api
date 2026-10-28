import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequirePermissions } from '../../common/auth/permissions.decorator';
import { AuditService } from './audit.service';
import { ListProjectAuditQueryDto } from './dto/list-project-audit-query.dto';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('project/:projectId')
  @RequirePermissions(GO_PERMISSIONS.AUDIT_READ)
  listProject(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListProjectAuditQueryDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.auditService.listProject(
      projectId,
      context.userId,
      context.userType,
      query.page,
      query.pageSize,
    );
  }
}
