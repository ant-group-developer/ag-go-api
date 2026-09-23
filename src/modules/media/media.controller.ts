import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
import { GO_PERMISSIONS } from '../../common/auth/permissions.constants';
import { RequireAnyPermissions, RequirePermissions } from '../../common/auth/permissions.decorator';
import { CreateProjectMediaDto } from './dto/create-project-media.dto';
import { ReorderProjectMediaDto } from './dto/reorder-project-media.dto';
import { SetProjectThumbnailDto } from './dto/set-project-thumbnail.dto';
import { UpdateProjectMediaDto } from './dto/update-project-media.dto';
import { MediaService } from './media.service';

@ApiTags('project-media')
@ApiBearerAuth()
@Controller()
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly authContext: AuthContextService,
  ) {}

  @Get('projects/:projectId/media')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  list(
    @Param('projectId') projectId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    return this.mediaService.list(
      projectId,
      context.userId,
      context.userType,
      cursor,
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    );
  }

  @Post('projects/:projectId/media')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  attach(
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectMediaDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.mediaService.attach(projectId, dto, context.userId, context.userType);
  }

  @Patch('project-media/:id')
  @RequireAnyPermissions(GO_PERMISSIONS.PROJECT_EDIT, GO_PERMISSIONS.PROJECT_EVALUATE)
  update(@Param('id') id: string, @Body() dto: UpdateProjectMediaDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.mediaService.update(
      id,
      dto,
      context.userId,
      context.permissions ?? [],
      context.userType,
    );
  }

  @Get('project-media/:id/evaluations')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
  listEvaluationHistory(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.mediaService.listEvaluationHistory(id, context.userId, context.userType);
  }

  @Delete('project-media/:id')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  async remove(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    await this.mediaService.remove(id, context.userId, context.userType);
    return { success: true };
  }

  @Patch('projects/:projectId/reorder-media')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  async reorder(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderProjectMediaDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    await this.mediaService.reorder(projectId, dto, context.userId, context.userType);
    return { success: true };
  }

  @Patch('projects/:projectId/thumbnail')
  @RequirePermissions(GO_PERMISSIONS.PROJECT_EDIT)
  setThumbnail(
    @Param('projectId') projectId: string,
    @Body() dto: SetProjectThumbnailDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.mediaService.setThumbnail(projectId, dto, context.userId, context.userType);
  }
}
