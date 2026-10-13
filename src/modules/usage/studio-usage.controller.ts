import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
import { ServiceOnly } from '../../common/auth/service-only.decorator';
import { ProjectEntity } from '../../database/entities/project.entity';
import { FolderAccessService } from '../folders/folder-access.service';
import { FootageScopeService } from '../footage/footage-scope.service';
import { StudioUsageEventsDto } from './dto/studio-events.dto';
import { StudioUsageService } from './studio-usage.service';

@ApiTags('usage')
@Controller()
export class StudioUsageController {
  constructor(
    private readonly usage: StudioUsageService,
    private readonly authContext: AuthContextService,
    private readonly footageScope: FootageScopeService,
    private readonly folderAccess: FolderAccessService,
    @InjectRepository(ProjectEntity)
    private readonly projectRepo: Repository<ProjectEntity>,
  ) {}

  @Post('usage/studio-events')
  @HttpCode(200)
  @ServiceOnly('usage:write')
  @ApiSecurity('service-key')
  @ApiOperation({ summary: 'Footage usage events from AG Studio (service key only)' })
  record(@Body() dto: StudioUsageEventsDto) {
    return this.usage.record(dto.events);
  }

  /** Usage of one footage: the user must see it in the footage library (404 otherwise). */
  @Get('footage/assets/:assetId/studio-usage')
  @ApiBearerAuth()
  @RequireAnyPermissions(GO_PERMISSIONS.FOOTAGE_SEARCH, GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({ summary: 'How AG Studio used one footage, and its downloads' })
  async assetUsage(@Param('assetId', ParseUUIDPipe) assetId: string, @Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    await this.footageScope.assertAssetsInScope([assetId], ctx);
    return this.usage.forAsset(assetId);
  }

  /** Usage of a project's footage, with the project's own access rule (like `GET /projects/:id`). */
  @Get('projects/:projectId/studio-usage')
  @ApiBearerAuth()
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  @ApiOperation({ summary: "How AG Studio used a project's footage, and their downloads" })
  async projectUsage(@Param('projectId', ParseUUIDPipe) projectId: string, @Req() req: Request) {
    const ctx = this.authContext.getContext(req);
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    if (!(await this.folderAccess.canViewProject(project, ctx.userId, ctx.userType))) {
      throw new ForbiddenException('Insufficient folder permission');
    }
    return this.usage.forProject(projectId);
  }
}
