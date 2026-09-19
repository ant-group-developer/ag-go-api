import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthContextService } from '../../common/auth-context.service';
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
      context.groupIds,
      cursor,
      Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    );
  }

  @Post('projects/:projectId/media')
  attach(
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectMediaDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.mediaService.attach(projectId, dto, context.userId, context.groupIds);
  }

  @Patch('project-media/:id')
  update(@Param('id') id: string, @Body() dto: UpdateProjectMediaDto, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    return this.mediaService.update(id, dto, context.userId, context.groupIds);
  }

  @Delete('project-media/:id')
  async remove(@Param('id') id: string, @Req() request: Request) {
    const context = this.authContext.getContext(request);
    await this.mediaService.remove(id, context.userId, context.groupIds);
    return { success: true };
  }

  @Patch('projects/:projectId/reorder-media')
  async reorder(
    @Param('projectId') projectId: string,
    @Body() dto: ReorderProjectMediaDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    await this.mediaService.reorder(projectId, dto, context.userId, context.groupIds);
    return { success: true };
  }

  @Patch('projects/:projectId/thumbnail')
  setThumbnail(
    @Param('projectId') projectId: string,
    @Body() dto: SetProjectThumbnailDto,
    @Req() request: Request,
  ) {
    const context = this.authContext.getContext(request);
    return this.mediaService.setThumbnail(projectId, dto, context.userId, context.groupIds);
  }
}
